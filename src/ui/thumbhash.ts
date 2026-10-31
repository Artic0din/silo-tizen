/*!
Copyright (c) 2023 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Decode-only ThumbHash. The algorithm is Evan Wallace's MIT-licensed reference
// (Copyright (c) 2023 Evan Wallace), with the bounds checks from silo-apple
// ThumbhashImage.swift. A person hero decodes its one preview when drawn;
// nothing here is cached globally.

export interface ThumbhashImage {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

// Header dimensions and channel counts fit within 32 bytes, or 44 Base64 characters.
const MAX_THUMBHASH_BYTES = 32;
const MAX_ENCODED_THUMBHASH_LENGTH = 4 * Math.ceil(MAX_THUMBHASH_BYTES / 3);

export function decodeThumbhash(encoded: string | undefined): ThumbhashImage | undefined {
    const hash = decodeBase64(encoded);
    const header = hash === undefined ? undefined : validatedHeader(hash);
    if (hash === undefined || header === undefined) return undefined;

    const header24 = hash[0]! | (hash[1]! << 8) | (hash[2]! << 16);
    const header16 = hash[3]! | (hash[4]! << 8);
    const lDc = (header24 & 63) / 63;
    const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
    const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
    const lScale = ((header24 >> 18) & 31) / 31;
    const pScale = ((header16 >> 3) & 63) / 63;
    const qScale = ((header16 >> 9) & 63) / 63;
    const aDc = header.hasAlpha ? (hash[5]! & 15) / 15 : 1;
    const aScale = header.hasAlpha ? (hash[5]! >> 4) / 15 : 1;
    let acIndex = 0;
    const decodeChannel = (nx: number, ny: number, scale: number): number[] => {
        const coefficients: number[] = [];
        for (let cy = 0; cy < ny; cy++) {
            for (let cx = cy > 0 ? 0 : 1; cx * ny < nx * (ny - cy); cx++) {
                const packed = hash[header.acStart + (acIndex >> 1)];
                if (packed === undefined) return [];
                const nibble = (packed >> ((acIndex & 1) << 2)) & 15;
                coefficients.push((nibble / 7.5 - 1) * scale);
                acIndex += 1;
            }
        }
        return coefficients;
    };
    const lAc = decodeChannel(header.lx, header.ly, lScale);
    const pAc = decodeChannel(3, 3, pScale * 1.25);
    const qAc = decodeChannel(3, 3, qScale * 1.25);
    const aAc = header.hasAlpha ? decodeChannel(5, 5, aScale) : [];
    const ratio = header.lx / header.ly;
    const width = Math.round(ratio > 1 ? 32 : 32 * ratio);
    const height = Math.round(ratio > 1 ? 32 / ratio : 32);
    if (width <= 0 || height <= 0) return undefined;

    const cxStop = Math.max(header.lx, header.hasAlpha ? 5 : 3);
    const cyStop = Math.max(header.ly, header.hasAlpha ? 5 : 3);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0, pixel = 0; y < height; y++) {
        for (let x = 0; x < width; x++, pixel += 4) {
            const fx: number[] = [];
            const fy: number[] = [];
            for (let cx = 0; cx < cxStop; cx++) fx.push(Math.cos(Math.PI / width * (x + 0.5) * cx));
            for (let cy = 0; cy < cyStop; cy++) fy.push(Math.cos(Math.PI / height * (y + 0.5) * cy));
            let l = lDc;
            let p = pDc;
            let q = qDc;
            let a = aDc;
            let coefficient = 0;
            for (let cy = 0; cy < header.ly; cy++) {
                const fy2 = (fy[cy] ?? 0) * 2;
                for (let cx = cy > 0 ? 0 : 1; cx * header.ly < header.lx * (header.ly - cy); cx++, coefficient++) {
                    l += (lAc[coefficient] ?? 0) * (fx[cx] ?? 0) * fy2;
                }
            }
            coefficient = 0;
            for (let cy = 0; cy < 3; cy++) {
                const fy2 = (fy[cy] ?? 0) * 2;
                for (let cx = cy > 0 ? 0 : 1; cx < 3 - cy; cx++, coefficient++) {
                    const factor = (fx[cx] ?? 0) * fy2;
                    p += (pAc[coefficient] ?? 0) * factor;
                    q += (qAc[coefficient] ?? 0) * factor;
                }
            }
            if (header.hasAlpha) {
                coefficient = 0;
                for (let cy = 0; cy < 5; cy++) {
                    const fy2 = (fy[cy] ?? 0) * 2;
                    for (let cx = cy > 0 ? 0 : 1; cx < 5 - cy; cx++, coefficient++) {
                        a += (aAc[coefficient] ?? 0) * (fx[cx] ?? 0) * fy2;
                    }
                }
            }
            const blue = l - 2 / 3 * p;
            const red = (3 * l - blue + q) / 2;
            const green = red - q;
            rgba[pixel] = Math.max(0, 255 * Math.min(1, red));
            rgba[pixel + 1] = Math.max(0, 255 * Math.min(1, green));
            rgba[pixel + 2] = Math.max(0, 255 * Math.min(1, blue));
            rgba[pixel + 3] = Math.max(0, 255 * Math.min(1, a));
        }
    }
    return { width, height, rgba };
}

function decodeBase64(encoded: string | undefined): Uint8Array | undefined {
    if (encoded === undefined || encoded.length > MAX_ENCODED_THUMBHASH_LENGTH) return undefined;
    const value = encoded.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
    const padded = value.length % 4 === 0 ? value : `${value}${"=".repeat(4 - (value.length % 4))}`;
    try {
        const binary = atob(padded);
        if (binary.length > MAX_THUMBHASH_BYTES) return undefined;
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return bytes;
    } catch {
        return undefined;
    }
}

interface Header {
    readonly hasAlpha: boolean;
    readonly lx: number;
    readonly ly: number;
    readonly acStart: number;
}

function validatedHeader(hash: Uint8Array): Header | undefined {
    if (hash.length < 5) return undefined;
    const hasAlpha = (hash[2]! & 0x80) !== 0;
    const dimension = hash[3]! & 7;
    if (dimension === 0 || hash.length < (hasAlpha ? 6 : 5)) return undefined;
    const isLandscape = (hash[4]! & 0x80) !== 0;
    const lx = Math.max(3, isLandscape ? (hasAlpha ? 5 : 7) : dimension);
    const ly = Math.max(3, isLandscape ? dimension : (hasAlpha ? 5 : 7));
    const acStart = hasAlpha ? 6 : 5;
    const coefficientCount = acCoefficientCount(lx, ly) + acCoefficientCount(3, 3) * 2 + (hasAlpha ? acCoefficientCount(5, 5) : 0);
    if (hash.length !== acStart + Math.floor((coefficientCount + 1) / 2)) return undefined;
    return { hasAlpha, lx, ly, acStart };
}

function acCoefficientCount(nx: number, ny: number): number {
    let count = 0;
    for (let cy = 0; cy < ny; cy++) {
        for (let cx = cy > 0 ? 0 : 1; cx * ny < nx * (ny - cy); cx++) count += 1;
    }
    return count;
}

import type { JsonValue, RequestSpec } from "./http.ts";
import { APPEARANCE_KEY, SYNC_KEY } from "../player/subtitleAppearance.ts";
import { boolean, integer, object, WireError } from "../contracts/v2/wire.ts";

export function decodeDeviceSetting(value: unknown, key: string, profileId: string, deviceId: string): boolean {
    const body = object(value, "explicit_settings");
    integer(body, "revision", "explicit_settings");
    if (!Array.isArray(body.items)) throw new WireError("explicit_settings.items", "an array");
    const rows = body.items.map(item => object(item, "explicit_setting")).filter(item => item.key === key);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || row.scope !== "profile_device" || row.profile_id !== profileId || row.device_id !== deviceId) throw new WireError("explicit_settings.items", "the device setting row");
    return boolean(row, "is_set", "explicit_setting");
}

export function decodeDeviceAppearance(value: unknown, profileId: string, deviceId: string): boolean {
    return decodeDeviceSetting(value, APPEARANCE_KEY, profileId, deviceId);
}

export function confirmSettingWrite(value: unknown, key: string, scope: string): undefined {
    const row = object(value, "setting_value");
    if (row.key !== key || row.scope !== scope) throw new WireError("setting_value", "the requested scoped setting");
    integer(row, "revision", "setting_value");
    return undefined;
}

export const subtitleDisplayOperations = {
    capabilities: (): RequestSpec<unknown> => ({ method: "GET", path: "/settings/contract/capabilities", retry: "safe", decode: value => value }),
    contract: (): RequestSpec<unknown> => ({ method: "GET", path: "/settings/contract", retry: "safe", decode: value => value }),
    deviceAppearance: (profileId: string, deviceId: string): RequestSpec<boolean> => ({
        method: "GET", path: `/settings/values?scope=profile_device&keys=${APPEARANCE_KEY}`, retry: "safe",
        decode: value => decodeDeviceAppearance(value, profileId, deviceId),
    }),
    deviceTiming: (profileId: string, deviceId: string): RequestSpec<boolean> => ({
        method: "GET", path: `/settings/values?scope=profile_device&keys=${SYNC_KEY}`, retry: "safe",
        decode: value => decodeDeviceSetting(value, SYNC_KEY, profileId, deviceId),
    }),
    put: (key: string, value: JsonValue, scope: "profile" | "profile_device"): RequestSpec<undefined> => ({
        method: "PUT", path: `/settings/values/${key}?scope=${scope}`, retry: "never", body: { value },
        decode: body => confirmSettingWrite(body, key, scope),
    }),
    delete: (key: string, scope: "profile" | "profile_device"): RequestSpec<undefined> => ({
        method: "DELETE", path: `/settings/values/${key}?scope=${scope}`, retry: "never", decode: () => undefined,
    }),
};

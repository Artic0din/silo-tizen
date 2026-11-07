// On-view description translation. Coalescing means the server reuses an active job;
// this client does not replay the POST itself. Subtitle AI stays in subtitleAIOperations.

import type { RequestSpec } from "./http.ts";
import { decodeDescriptionTranslationJob, decodeMetadataAICapability, type DescriptionJob, type MetadataAICapability } from "../contracts/v2/descriptionTranslation.ts";

export const descriptionTranslationOperations = {
    metadataAI: (): RequestSpec<MetadataAICapability> => ({ method: "GET", path: "/capabilities/metadata-ai", retry: "safe", decode: decodeMetadataAICapability }),
    translateDescription: (contentId: string, targetLanguage: string): RequestSpec<DescriptionJob> => ({
        method: "POST",
        path: `/catalog/items/${encodeURIComponent(contentId)}/translate-description`,
        retry: "never",
        body: { target_language: targetLanguage },
        decode: (value) => decodeDescriptionTranslationJob(value, contentId),
    }),
};

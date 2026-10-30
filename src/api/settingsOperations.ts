import { decodeEffectiveSettings, decodeExplicitSettings, decodeSettingValue, decodeSettingsCapabilities, decodeSettingsContract, decodeStoredSetting, type SettingsKey, type SettingValue } from "../contracts/v2/settings.ts";
import type { RequestSpec } from "./http.ts";

function keysQuery(keys: readonly SettingsKey[]): string {
    return keys.map(key => `keys=${encodeURIComponent(key)}`).join("&");
}
export const settingsOperations = {
    settingsCapabilities: (): RequestSpec<ReturnType<typeof decodeSettingsCapabilities>> => ({ method: "GET", path: "/settings/contract/capabilities", retry: "safe", decode: decodeSettingsCapabilities }),
    settingsContract: (): RequestSpec<ReturnType<typeof decodeSettingsContract>> => ({ method: "GET", path: "/settings/contract", retry: "safe", decode: decodeSettingsContract }),
    settingsValues: (keys: readonly SettingsKey[]): RequestSpec<ReturnType<typeof decodeExplicitSettings>> => ({ method: "GET", path: `/settings/values?scope=profile&${keysQuery(keys)}`, retry: "safe", decode: body => decodeExplicitSettings(keys, body) }),
    effectiveSettings: (keys: readonly SettingsKey[]): RequestSpec<ReturnType<typeof decodeEffectiveSettings>> => ({ method: "GET", path: `/settings/values/effective?${keysQuery(keys)}`, retry: "safe", decode: body => decodeEffectiveSettings(keys, body) }),
    putSetting: (key: SettingsKey, value: SettingValue): RequestSpec<ReturnType<typeof decodeStoredSetting>> => ({ method: "PUT", path: `/settings/values/${key}?scope=profile`, retry: "never", body: { value: decodeSettingValue(key, value) }, decode: body => decodeStoredSetting(key, body) }),
    deleteSetting: (key: SettingsKey): RequestSpec<undefined> => ({ method: "DELETE", path: `/settings/values/${key}?scope=profile`, retry: "never", decode: () => undefined }),
};

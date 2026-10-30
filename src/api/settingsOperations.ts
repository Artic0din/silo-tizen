import { decodeEffectiveSettings, decodeExplicitSettings, decodeSettingValue, decodeSettingsCapabilities, decodeSettingsContract, decodeStoredSetting, type SettingsIdentity, type SettingsScope, type SettingsKey, type SettingValue } from "../contracts/v2/settings.ts";
import type { RequestSpec } from "./http.ts";

function keysQuery(keys: readonly SettingsKey[]): string {
    return keys.map(key => `keys=${encodeURIComponent(key)}`).join("&");
}
export const settingsOperations = {
    settingsCapabilities: (): RequestSpec<ReturnType<typeof decodeSettingsCapabilities>> => ({ method: "GET", path: "/settings/contract/capabilities", retry: "safe", decode: decodeSettingsCapabilities }),
    settingsContract: (): RequestSpec<ReturnType<typeof decodeSettingsContract>> => ({ method: "GET", path: "/settings/contract", retry: "safe", decode: decodeSettingsContract }),
    settingsValues: (keys: readonly SettingsKey[], scope: SettingsScope = "profile", identity?: SettingsIdentity): RequestSpec<ReturnType<typeof decodeExplicitSettings>> => ({ method: "GET", path: `/settings/values?scope=${scope}&${keysQuery(keys)}`, retry: "safe", decode: body => decodeExplicitSettings(keys, body, scope, identity) }),
    effectiveSettings: (keys: readonly SettingsKey[], identity?: SettingsIdentity): RequestSpec<ReturnType<typeof decodeEffectiveSettings>> => ({ method: "GET", path: `/settings/values/effective?${keysQuery(keys)}`, retry: "safe", decode: body => decodeEffectiveSettings(keys, body, identity) }),
    putSetting: (key: SettingsKey, value: SettingValue, scope: SettingsScope = "profile", identity?: SettingsIdentity, previousRevision = 0): RequestSpec<ReturnType<typeof decodeStoredSetting>> => ({ method: "PUT", path: `/settings/values/${key}?scope=${scope}`, retry: "never", body: { value: decodeSettingValue(key, value) }, decode: body => decodeStoredSetting(key, body, scope, identity, previousRevision) }),
    deleteSetting: (key: SettingsKey, scope: SettingsScope = "profile"): RequestSpec<undefined> => ({ method: "DELETE", path: `/settings/values/${key}?scope=${scope}`, retry: "never", decode: () => undefined }),
};

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  isEnabled,
  getAllFlagNames,
  getFlagDescription,
  getDefaultFlagValue,
  getActiveFlags,
  setFlagOverride,
  clearFlagOverride,
  clearAllOverrides,
  getFlagOverrides,
  parseUrlOverrides,
  loadOverrides,
  saveOverrides,
  getFlagDefinitions,
  initFeatureFlags,
  logActiveFlags,
  getUrlOverrides,
} from "@/lib/feature-flags";

describe("Feature Flags", () => {
  beforeEach(() => {
    clearAllOverrides();
    vi.restoreAllMocks();
  });

  it("returns all defined flag names", () => {
    const names = getAllFlagNames();
    expect(names).toContain("newDashboard");
    expect(names).toContain("newMessaging");
    expect(names).toContain("biddingSystem");
    expect(names).toContain("milestones");
    expect(names).toContain("multiToken");
  });

  it("returns correct descriptions for flags", () => {
    expect(getFlagDescription("newDashboard")).toBe("New analytics dashboard layout");
    expect(getFlagDescription("newMessaging")).toBe("Redesigned messaging interface");
    expect(getFlagDescription("nonexistent")).toBe("");
  });

  it("returns false as default value for all flags", () => {
    expect(getDefaultFlagValue("newDashboard")).toBe(false);
    expect(getDefaultFlagValue("nonexistent")).toBe(false);
  });

  it("returns false for unknown flags", () => {
    expect(isEnabled("unknownFlag")).toBe(false);
  });

  it("returns default value when no overrides exist", () => {
    expect(isEnabled("newDashboard")).toBe(false);
    expect(isEnabled("newMessaging")).toBe(false);
  });

  it("respects flag overrides", () => {
    setFlagOverride("newDashboard", true);
    expect(isEnabled("newDashboard")).toBe(true);

    setFlagOverride("newDashboard", false);
    expect(isEnabled("newDashboard")).toBe(false);
  });

  it("clears individual flag overrides", () => {
    setFlagOverride("newDashboard", true);
    expect(isEnabled("newDashboard")).toBe(true);

    clearFlagOverride("newDashboard");
    expect(isEnabled("newDashboard")).toBe(false);
  });

  it("clears all overrides", () => {
    setFlagOverride("newDashboard", true);
    setFlagOverride("newMessaging", true);

    clearAllOverrides();
    expect(isEnabled("newDashboard")).toBe(false);
    expect(isEnabled("newMessaging")).toBe(false);
  });

  it("returns active flags state", () => {
    setFlagOverride("newDashboard", true);
    const active = getActiveFlags();
    expect(active.newDashboard).toBe(true);
    expect(active.newMessaging).toBe(false);
  });

  it("returns flag overrides", () => {
    setFlagOverride("biddingSystem", true);
    const overrides = getFlagOverrides();
    expect(overrides.biddingSystem).toBe(true);
  });

  it("ignores overrides for undefined flags", () => {
    setFlagOverride("nonexistentFlag", true);
    expect(isEnabled("nonexistentFlag")).toBe(false);
  });

  it("parses URL overrides correctly", () => {
    const result = parseUrlOverrides("?feature.newDashboard=true&feature.milestones=false&other=1");
    expect(result.newDashboard).toBe(true);
    expect(result.milestones).toBe(false);
    expect(result).not.toHaveProperty("other");
  });

  it("parses URL overrides with 1/0 values", () => {
    const result = parseUrlOverrides("?feature.biddingSystem=1&feature.multiToken=0");
    expect(result.biddingSystem).toBe(true);
    expect(result.multiToken).toBe(false);
  });

  it("ignores unknown flags in URL", () => {
    const result = parseUrlOverrides("?feature.unknownFlag=true");
    expect(result).not.toHaveProperty("unknownFlag");
  });

  it("URL overrides take precedence over localStorage overrides", () => {
    setFlagOverride("newDashboard", false);
    parseUrlOverrides("?feature.newDashboard=true");
    expect(isEnabled("newDashboard")).toBe(true);
  });

  it("loads overrides from localStorage", () => {
    localStorage.setItem(
      "stellarwork:feature-flags",
      JSON.stringify({ newDashboard: true, newMessaging: false })
    );
    const loaded = loadOverrides();
    expect(loaded.newDashboard).toBe(true);
    expect(loaded.newMessaging).toBe(false);
  });

  it("handles corrupted localStorage gracefully", () => {
    localStorage.setItem("stellarwork:feature-flags", "not-json");
    const loaded = loadOverrides();
    expect(loaded).toEqual({});
  });

  it("filters out non-boolean values from localStorage", () => {
    localStorage.setItem(
      "stellarwork:feature-flags",
      JSON.stringify({ newDashboard: "yes", newMessaging: true, biddingSystem: 42 })
    );
    const loaded = loadOverrides();
    expect(loaded.newMessaging).toBe(true);
    expect(loaded).not.toHaveProperty("newDashboard");
    expect(loaded).not.toHaveProperty("biddingSystem");
  });

  it("saves overrides to localStorage", () => {
    saveOverrides({ newDashboard: true, milestones: false });
    const raw = localStorage.getItem("stellarwork:feature-flags");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.newDashboard).toBe(true);
    expect(parsed.milestones).toBe(false);
  });

  it("getFlagDefinitions returns a copy of definitions", () => {
    const defs = getFlagDefinitions();
    expect(defs.newDashboard).toBeDefined();
    expect(defs.newDashboard.defaultValue).toBe(false);
  });

  it("initFeatureFlags loads overrides and parses URL", () => {
    localStorage.setItem(
      "stellarwork:feature-flags",
      JSON.stringify({ newDashboard: true })
    );
    initFeatureFlags();
    expect(isEnabled("newDashboard")).toBe(true);
  });

  it("logActiveFlags does not throw", () => {
    expect(() => logActiveFlags()).not.toThrow();
  });

  it("getUrlOverrides returns parsed URL state", () => {
    parseUrlOverrides("?feature.multiToken=true");
    const urlOv = getUrlOverrides();
    expect(urlOv.multiToken).toBe(true);
  });

  // BUG-61: loadOverrides must reset in-memory overrides on every failed load
  // path, not just on a successful read. Previously, all early-return paths
  // returned {} without touching the module-level `overrides` object, so a
  // previously-loaded true value remained effective after the storage key was
  // removed or corrupted.
  describe("BUG-61: loadOverrides resets stale in-memory flags on failed load", () => {
    it("resets overrides when storage key is deleted", () => {
      // Establish a true override in-memory and in storage.
      setFlagOverride("newDashboard", true);
      expect(isEnabled("newDashboard")).toBe(true);

      // Remove the storage key and reload — must clear the in-memory map.
      localStorage.removeItem("stellarwork:feature-flags");
      loadOverrides();
      expect(isEnabled("newDashboard")).toBe(false);
    });

    it("resets overrides when stored JSON is invalid", () => {
      setFlagOverride("newMessaging", true);
      expect(isEnabled("newMessaging")).toBe(true);

      localStorage.setItem("stellarwork:feature-flags", "not-valid-json");
      loadOverrides();
      expect(isEnabled("newMessaging")).toBe(false);
    });

    it("resets overrides when stored value is a JSON primitive (not an object)", () => {
      setFlagOverride("milestones", true);
      expect(isEnabled("milestones")).toBe(true);

      localStorage.setItem("stellarwork:feature-flags", JSON.stringify(42));
      loadOverrides();
      expect(isEnabled("milestones")).toBe(false);
    });

    it("resets overrides when a read exception is thrown", () => {
      // Set a true override in-memory via saveOverrides directly (bypassing
      // localStorage so the spy below doesn't interfere with the setup call).
      saveOverrides({ biddingSystem: true });
      // Confirm the in-memory flag is live.
      expect(getFlagOverrides().biddingSystem).toBe(true);

      // Corrupt the stored value so parsing throws — invalid JSON causes the
      // catch branch (which now resets overrides) to fire.
      localStorage.setItem("stellarwork:feature-flags", "{bad json}");
      loadOverrides();
      expect(isEnabled("biddingSystem")).toBe(false);
    });

    it("does not retain flags that were not in the reload result", () => {
      // A flag with no prior override should not appear after a failed load.
      setFlagOverride("newDashboard", true);
      setFlagOverride("newMessaging", true);

      // Remove storage — both flags must be cleared.
      localStorage.removeItem("stellarwork:feature-flags");
      loadOverrides();
      expect(isEnabled("newDashboard")).toBe(false);
      expect(isEnabled("newMessaging")).toBe(false);
    });

    it("retains a valid flag that is present in storage after a reload", () => {
      setFlagOverride("newDashboard", true);
      setFlagOverride("newMessaging", true);

      // Overwrite storage to only contain newDashboard.
      localStorage.setItem(
        "stellarwork:feature-flags",
        JSON.stringify({ newDashboard: true })
      );
      loadOverrides();
      expect(isEnabled("newDashboard")).toBe(true);
      // newMessaging was not in storage — must be cleared.
      expect(isEnabled("newMessaging")).toBe(false);
    });
  });
});

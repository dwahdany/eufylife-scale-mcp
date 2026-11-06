import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EufyError, parseMeasurements, parseMembers } from "../src/eufy";

const fixtures = new URL("../../tests/core/fixtures/", import.meta.url);
const loginOk = JSON.parse(readFileSync(new URL("login_ok.json", fixtures), "utf8"));
const deviceData = JSON.parse(readFileSync(new URL("device_data.json", fixtures), "utf8"));

describe("parseMembers", () => {
  it("reads the customers of the recorded login response", () => {
    expect(parseMembers(loginOk.customers)).toEqual([
      { id: "cust-ann", name: "Ann Lee", isDefault: true },
      { id: "cust-bob", name: "Bob", isDefault: false },
    ]);
  });

  it("treats a missing list as empty and rejects garbage", () => {
    expect(parseMembers(undefined)).toEqual([]);
    expect(() => parseMembers("nope")).toThrow(EufyError);
    expect(() => parseMembers([{ name: "no id" }])).toThrow(EufyError);
  });
});

describe("parseMeasurements", () => {
  it("reads the recorded device data", () => {
    const records = parseMeasurements(deviceData.data);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ id: "rec-1", customerId: "cust-ann", time: 1790326800 });
    expect(records[0].scaleData.weight).toBe(652);
    expect(records[0].scaleData.heart_rate).toBe(0);
  });

  it("maps null metrics to 0 and skips records without the fields we need", () => {
    const records = parseMeasurements([
      { id: 7, customer_id: "c", create_time: 10, scale_data: { weight: null, bmi: "22.5" } },
      { id: "no-scale-data", customer_id: "c", create_time: 10 },
      { customer_id: "c", create_time: 10, scale_data: {} },
      "junk",
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("7");
    expect(records[0].scaleData.weight).toBe(0);
    expect(records[0].scaleData.bmi).toBe(22.5);
  });
});

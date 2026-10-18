import { expect, it } from "vitest";
import { koreanHolidays } from "./koreanHolidays";

it("moves eligible weekend holidays to the next free weekday", () => {
  const holidays = koreanHolidays(2026);
  for (const date of ["2026-03-02", "2026-08-17", "2026-10-05"]) {
    expect(holidays.get(date)).toBe("대체공휴일");
  }
  // Memorial Day has no substitute, and a Saturday alone in the Chuseok span does not trigger one.
  expect(holidays.has("2026-06-08")).toBe(false);
  expect(holidays.has("2026-09-28")).toBe(false);
});

it("places one substitute after the entire lunar span and skips its Monday holiday", () => {
  const holidays = koreanHolidays(2027);
  for (const date of ["2027-02-05", "2027-02-06", "2027-02-07"]) expect(holidays.get(date)).toBe("설날");
  expect(holidays.get("2027-02-08")).toBe("대체공휴일");
  expect(holidays.has("2027-02-09")).toBe(false);
});

it("bundles the election and lunar dates only for the listed years while retaining fixed rules", () => {
  expect(koreanHolidays(2026).get("2026-06-03")).toBe("전국동시지방선거");
  expect(koreanHolidays(2027).get("2027-05-13")).toBe("부처님오신날");
  expect(koreanHolidays(2026).get("2026-05-25")).toBe("대체공휴일");
  expect(koreanHolidays(2028).has("2028-02-06")).toBe(false);
  expect(koreanHolidays(2028).get("2028-10-03")).toBe("개천절");
});

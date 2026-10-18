import { addDays } from "./homeCalendarModel";

type Holiday = { name: string; dates: string[]; substitute?: "weekend" | "sunday" };

// Update this lunar/election table with app releases each year; no lunar dates are inferred outside it.
const YEARLY: Record<number, Holiday[]> = {
  2026: [
    { name: "설날", dates: ["02-16", "02-17", "02-18"], substitute: "sunday" },
    { name: "부처님오신날", dates: ["05-24"], substitute: "weekend" },
    { name: "추석", dates: ["09-24", "09-25", "09-26"], substitute: "sunday" },
    { name: "전국동시지방선거", dates: ["06-03"] },
  ],
  2027: [
    { name: "설날", dates: ["02-05", "02-06", "02-07"], substitute: "sunday" },
    { name: "부처님오신날", dates: ["05-13"], substitute: "weekend" },
    { name: "추석", dates: ["09-14", "09-15", "09-16"], substitute: "sunday" },
  ],
};

const FIXED: Holiday[] = [
  { name: "신정", dates: ["01-01"] },
  { name: "삼일절", dates: ["03-01"], substitute: "weekend" },
  { name: "어린이날", dates: ["05-05"], substitute: "weekend" },
  { name: "현충일", dates: ["06-06"] },
  { name: "광복절", dates: ["08-15"], substitute: "weekend" },
  { name: "개천절", dates: ["10-03"], substitute: "weekend" },
  { name: "한글날", dates: ["10-09"], substitute: "weekend" },
  { name: "성탄절", dates: ["12-25"], substitute: "weekend" },
];

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Shared PC/tablet calendar data. Substitutes follow the requested weekend and lunar-span rules. */
export function koreanHolidays(year: number): ReadonlyMap<string, string> {
  const groups = [...FIXED, ...(YEARLY[year] ?? [])].map(holiday => ({
    ...holiday, dates: holiday.dates.map(date => `${year}-${date}`),
  })).sort((a, b) => a.dates[0]!.localeCompare(b.dates[0]!));
  const names = new Map<string, string[]>();
  for (const holiday of groups) for (const date of holiday.dates) {
    names.set(date, [...(names.get(date) ?? []), holiday.name]);
  }
  const result = new Map([...names].map(([date, labels]) => [date, labels.join(" · ")]));
  for (const holiday of groups) {
    if (!holiday.substitute) continue;
    const needsSubstitute = holiday.dates.some(date => {
      const day = weekday(date);
      const overlaps = (names.get(date)?.length ?? 0) > 1;
      return day === 0 || (holiday.substitute === "weekend" && day === 6)
        || (overlaps && (holiday.substitute === "sunday" || holiday.name === "어린이날"));
    });
    if (!needsSubstitute) continue;
    let date = addDays(holiday.dates[holiday.dates.length - 1]!, 1);
    while (weekday(date) === 0 || weekday(date) === 6 || result.has(date)) date = addDays(date, 1);
    result.set(date, "대체공휴일");
  }
  return result;
}

import { describe, expect, it } from "vitest";
import { NO_PERFORMER, performerGroups } from "./performerGroups";

type Work = { id: string; people: { id: string; displayName: string; order: number }[] };
const person = (id: string, displayName: string, order: number) => ({ id, displayName, order });

describe("performerGroups", () => {
  it("puts a work under each of its performers, keeps the list order inside a group and ends with 배우 없음", () => {
    const works: Work[] = [
      { id: "duo", people: [person("rin", "아마노 린", 0), person("mio", "하야세 미오", 1)] },
      { id: "none", people: [] },
      { id: "solo", people: [person("mio", "하야세 미오", 0)] },
      { id: "guest", people: [person("aoi", "가와이 아오이", 1)] },
      { id: "twice", people: [person("rin", "아마노 린", 0), person("rin", "아마노 린", 1)] },
    ];
    const groups = performerGroups(works, work => work.people).map(group => [group.person?.displayName ?? NO_PERFORMER, group.items.map(work => work.id)]);
    // First-credited performers lead (by name), then those only ever credited later; a double credit shows once.
    expect(groups).toEqual([
      ["아마노 린", ["duo", "twice"]],
      ["하야세 미오", ["duo", "solo"]],
      ["가와이 아오이", ["guest"]],
      [NO_PERFORMER, ["none"]],
    ]);
  });

  it("has no 배우 없음 group when every work has a performer, and none at all for an empty list", () => {
    expect(performerGroups([{ id: "a", people: [person("p", "P", 0)] }], work => work.people).map(group => group.person?.id)).toEqual(["p"]);
    expect(performerGroups([] as Work[], work => work.people)).toEqual([]);
  });
});

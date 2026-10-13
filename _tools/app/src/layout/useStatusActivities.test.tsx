import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ActivityItem } from "./activityTimeline";
const registry = vi.hoisted(() => ({ jobs: [] as ActivityItem[], restricted: false, dismiss: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./useActivityRegistry", () => ({ useActivityRegistry: () => registry.jobs, dismissNativeActivity: registry.dismiss }));
vi.mock("../app/workloadProfile", () => ({ nativeWorkload: () => false, useWorkloadProfile: () => ({ restricted: registry.restricted }) }));
import { ActivityList, resetActivityFold } from "./ActivityList";
import { useStatusActivities } from "./useStatusActivities";
const character = { revision: 0, persistentError: null, historyRefreshActive: false, paused: false, dismissError: vi.fn(), pauseHistoryRefresh: vi.fn(), resumeHistoryRefresh: vi.fn(), setupRuntime: vi.fn() };
const defaults = { characterAutomation: character, progress: null, publicationJobs: [], vaultImport: null, vaultExport: null, inbox: { status: null, dismiss: vi.fn() }, go: vi.fn() };
function Harness({ publicationJobs = defaults.publicationJobs }: { publicationJobs?: Parameters<typeof useStatusActivities>[0]["publicationJobs"] }) {
  return <ActivityList sections={useStatusActivities({ ...defaults, publicationJobs })} />;
}
afterEach(() => { cleanup(); resetActivityFold(); registry.jobs = []; registry.restricted = false; vi.clearAllMocks(); });

it("maps the current publication result once while retaining previous native results", () => {
  registry.jobs = [
    { id: "old", kind: "publication_catalog", label: "이전 게시", state: "done", done: 1, total: 1, startedAt: Date.now() - 4000, finishedAt: Date.now() - 3000 },
    { id: "new", kind: "publication_catalog", label: "카탈로그 게시", state: "done", done: 2, total: 2, startedAt: Date.now() - 2000, finishedAt: Date.now() - 1000 },
  ];
  render(<Harness publicationJobs={[{ kind: "catalog", running: false, progress: { phase: "publishing", completed: 2, total: 2, unit: "items" }, message: "최근 게시 결과", error: false }]} />);
  act(() => screen.getByRole("button", { name: /최근 끝남/ }).click());
  const recent = screen.getByRole("group", { name: "최근 끝남" });
  expect(within(recent).getAllByText("카탈로그 게시")).toHaveLength(1);
  expect(recent).toHaveTextContent("최근 게시 결과");
  expect(recent).toHaveTextContent("이전 게시");
});

it("shares one pause between native reinforcement and Claude rows", () => {
  registry.jobs = [
    { id: "reference", kind: "reference_reinforcement", label: "레퍼런스 보강", state: "running", done: 0, pauseGroup: "character", startedAt: Date.now() - 2000 },
    { id: "claude", kind: "character_claude", label: "Claude 자동 판단", state: "queued", done: 0, total: 8, pauseGroup: "character" },
  ];
  render(<Harness />);
  act(() => screen.getByRole("button", { name: "레퍼런스 보강 일시 정지" }).click());
  expect(character.pauseHistoryRefresh).toHaveBeenCalledTimes(1);
  const waiting = screen.getByRole("group", { name: "대기" });
  expect(waiting).toHaveTextContent("레퍼런스 보강일시 정지됨");
  expect(waiting).toHaveTextContent("Claude 자동 판단0 / 8 · 일시 정지됨");
});

it("keeps a cloud problem above uploads that are still running", () => {
  registry.jobs = [
    { id: "upload", kind: "cloud_upload", label: "클라우드 업로드", state: "running", done: 6, total: 10, detail: "4개 남음", pauseGroup: "cloud", startedAt: Date.now() - 2000 },
    { id: "problem", kind: "cloud_upload_problem", label: "클라우드 업로드 문제", state: "failed", done: 1, error: "업로드 실패" },
  ];
  render(<Harness />);
  expect(screen.getByRole("group", { name: "문제" })).toHaveTextContent("업로드 실패");
  expect(screen.getByRole("group", { name: "진행 중" })).toHaveTextContent("클라우드 업로드4개 남음");
});

it("keeps saver work waiting with its reason and offers the real shared pause", () => {
  registry.restricted = true;
  registry.jobs = [{ id: "claude", kind: "character_claude", label: "Claude 자동 판단", state: "running", done: 3, total: 8, pauseGroup: "character", startedAt: Date.now() - 2000 }];
  render(<Harness />);
  expect(screen.queryByRole("group", { name: "진행 중" })).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "대기" })).toHaveTextContent("3 / 8 · 절약 모드");
  act(() => screen.getByRole("button", { name: "Claude 자동 판단 일시 정지" }).click());
  expect(character.pauseHistoryRefresh).toHaveBeenCalledTimes(1);
});

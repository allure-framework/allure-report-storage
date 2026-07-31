import { describe, expect, it } from "vitest";

import { D1ProjectRepository } from "../../../src/repositories/d1/projects.js";
import { D1ReportRepository } from "../../../src/repositories/d1/reports.js";
import { MemoryD1Database } from "../support/cloudflare.js";

const pauseForOrdering = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

describe("D1ReportRepository", () => {
  it("stores report lifecycle data and preserves completed report immutability", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });

    try {
      let result = await repository.createOrUpdateDraft({
        branch: "main",
        name: "Draft",
        repo: "qameta/allure-report-storage",
        reportId: "r1",
      });

      expect(result.conflict).toBe(false);
      expect(result.report).toMatchObject({ branch: "main", id: "r1", name: "Draft", status: "draft" });

      result = await repository.createOrUpdateDraft({
        branch: "release",
        name: "Updated draft",
        repo: "qameta/allure-report-storage",
        reportId: "r1",
      });

      expect(result.conflict).toBe(false);
      expect(result.report).toMatchObject({ branch: "release", name: "Updated draft" });

      const completed = await repository.complete("r1");

      expect(completed).toMatchObject({
        conflict: false,
        notFound: false,
        report: { status: "completed" },
      });

      expect(await repository.complete("r1")).toMatchObject({
        conflict: true,
        notFound: false,
      });
      expect(
        await repository.createOrUpdateDraft({
          branch: "main",
          repo: "qameta/allure-report-storage",
          reportId: "r1",
        }),
      ).toMatchObject({ conflict: true });
    } finally {
      database.close();
    }
  });

  it("falls back to main branch history after branch-specific history", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });

    try {
      for (const [reportId, branch] of [
        ["main-1", "main"],
        ["release-1", "release"],
        ["main-2", "main"],
      ] as const) {
        await repository.createOrUpdateDraft({
          branch,
          repo: "qameta/allure-report-storage",
          reportId,
        });
        await repository.complete(reportId);
        await pauseForOrdering();
      }

      const reports = await repository.listHistory({
        branch: "release",
        fallbackBranch: "main",
        limit: 3,
        repo: "qameta/allure-report-storage",
      });

      expect(reports.map((report) => report.id)).toEqual(["release-1", "main-1"]);

      const unlimitedReports = await repository.listHistory({
        branch: "release",
        fallbackBranch: "main",
        repo: "qameta/allure-report-storage",
      });

      expect(unlimitedReports.map((report) => report.id)).toEqual(["release-1", "main-1"]);

      const missingBranchReports = await repository.listHistory({
        branch: "missing",
        fallbackBranch: "main",
        repo: "qameta/allure-report-storage",
      });

      expect(missingBranchReports.map((report) => report.id)).toEqual(["main-2", "main-1"]);
    } finally {
      database.close();
    }
  });

  it("lists retention candidates through D1 select queries", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });

    try {
      for (const reportId of ["retention-1", "retention-2", "retention-3"] as const) {
        await repository.createOrUpdateDraft({
          branch: "main",
          repo: "qameta/allure-report-storage",
          reportId,
        });
        await repository.complete(reportId);
        await pauseForOrdering();
      }

      const candidates = await repository.listRetentionCandidates({ maxReportsPerBranch: 1 });

      expect(candidates.map((report) => report.id)).toEqual(["retention-2", "retention-1"]);
    } finally {
      database.close();
    }
  });

  it("does not delete a retention candidate that became branch latest", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });

    try {
      for (const reportId of ["race-1", "race-2"] as const) {
        await repository.createOrUpdateDraft({
          branch: "main",
          repo: "qameta/allure-report-storage",
          reportId,
        });
        await repository.complete(reportId);
        await pauseForOrdering();
      }

      const candidate = (await repository.findById("race-1"))!;

      await repository.delete("race-2");

      expect(await repository.deleteRetentionCandidate(candidate)).toBe(false);
      expect(await repository.findById("race-1")).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("stores project main branch metadata", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ProjectRepository.create({ database });

    try {
      const created = await repository.upsertMainBranch({ mainBranch: "trunk", repo: "qameta/allure-report-storage" });

      expect(created).toMatchObject({ mainBranch: "trunk", repo: "qameta/allure-report-storage" });

      const updated = await repository.upsertMainBranch({
        mainBranch: "release",
        repo: "qameta/allure-report-storage",
      });

      expect(updated).toMatchObject({ mainBranch: "release", repo: "qameta/allure-report-storage" });
      expect(await repository.findByRepo("qameta/allure-report-storage")).toMatchObject({
        mainBranch: "release",
        repo: "qameta/allure-report-storage",
      });
      expect(await repository.findByRepo("missing/repo")).toBeNull();
    } finally {
      database.close();
    }
  });
});

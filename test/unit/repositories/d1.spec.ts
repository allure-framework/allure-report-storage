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

  it("stores project main branch metadata", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ProjectRepository.create({ database });

    try {
      const created = await repository.upsertMainBranch({ mainBranch: "trunk", repo: "qameta/allure-report-storage" });

      expect(created).toMatchObject({ mainBranch: "trunk", repo: "qameta/allure-report-storage" });

      const updated = await repository.upsertMainBranch({ mainBranch: "release", repo: "qameta/allure-report-storage" });

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

import { describe, expect, it, vi } from "vitest";

import { D1AccessTokenRepository } from "../../../src/repositories/d1/accessTokens.js";
import { D1ProjectRepository } from "../../../src/repositories/d1/projects.js";
import { D1ReportRepository } from "../../../src/repositories/d1/reports.js";
import { MemoryD1Database } from "../support/cloudflare.js";

const pauseForOrdering = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

describe("D1AccessTokenRepository", () => {
  it("reuses recently verified access tokens without another D1 query", async () => {
    const database = new MemoryD1Database();
    const writer = await D1AccessTokenRepository.create({ database });

    try {
      const created = await writer.create({
        accessTokenHash: "cached-token-hash",
        id: "cached-token",
      });
      const reader = await D1AccessTokenRepository.create({ database });

      await expect(reader.findByAccessTokenHash(created.accessTokenHash)).resolves.toEqual(created);
      await expect(reader.findByAccessTokenHash(created.accessTokenHash)).resolves.toEqual(created);
      expect(database.preparedQueries.filter((query) => /\bfrom\s+["`]?access_tokens\b/i.test(query))).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps access token caches isolated by D1 binding", async () => {
    const firstDatabase = new MemoryD1Database();
    const secondDatabase = new MemoryD1Database();
    const writer = await D1AccessTokenRepository.create({ database: firstDatabase });
    const reader = await D1AccessTokenRepository.create({ database: secondDatabase });

    try {
      await writer.create({
        accessTokenHash: "database-specific-token-hash",
        id: "database-specific-token",
      });

      await expect(reader.findByAccessTokenHash("database-specific-token-hash")).resolves.toBeNull();
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
  });

  it("coalesces concurrent D1 lookups for the same access token", async () => {
    const database = new MemoryD1Database();

    try {
      await database.exec(`
        insert into access_tokens (id, access_token_hash, created_at)
        values ('existing-token', 'existing-token-hash', '2026-01-01T00:00:00.000Z')
      `);

      const firstRepository = await D1AccessTokenRepository.create({ database });
      const secondRepository = await D1AccessTokenRepository.create({ database });
      const [first, second] = await Promise.all([
        firstRepository.findByAccessTokenHash("existing-token-hash"),
        secondRepository.findByAccessTokenHash("existing-token-hash"),
      ]);

      expect(first).toEqual(second);
      expect(first).toMatchObject({ id: "existing-token" });
      expect(database.preparedQueries.filter((query) => /\bfrom\s+["`]?access_tokens\b/i.test(query))).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

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

  it("lists the latest completed report for each repository branch", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    try {
      for (const [reportId, repo, branch, completed] of [
        ["main-a", "qameta/a", "main", true],
        ["main-z", "qameta/a", "main", true],
        ["release", "qameta/a", "release", true],
        ["trunk", "qameta/b", "trunk", true],
        ["draft", "qameta/draft-only", "next", false],
      ] as const) {
        await repository.createOrUpdateDraft({ branch, repo, reportId });

        if (completed) {
          await repository.complete(reportId);
        }
      }

      await expect(repository.listLatestCompletedPage({ limit: 1 })).resolves.toEqual({
        nextRepo: "qameta/a",
        reports: [
          { branch: "main", repo: "qameta/a", reportId: "main-z" },
          { branch: "release", repo: "qameta/a", reportId: "release" },
        ],
      });
      await expect(repository.listLatestCompletedPage({ afterRepo: "qameta/a", limit: 1 })).resolves.toEqual({
        nextRepo: null,
        reports: [{ branch: "trunk", repo: "qameta/b", reportId: "trunk" }],
      });
    } finally {
      vi.useRealTimers();
      database.close();
    }
  });

  it("keeps maximum-size discovery pages within the D1 bind limit", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });
    const completedAt = "2026-01-01T00:00:00.000Z";
    const rows = Array.from({ length: 101 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");

      return `('report-${suffix}', 'repo-${suffix}', 'main', null, 'completed', '${completedAt}', '${completedAt}', '${completedAt}')`;
    });

    try {
      await database.exec(`
        insert into reports (id, repo, branch, name, status, created_at, updated_at, completed_at)
        values ${rows.join(",")}
      `);

      const page = await repository.listLatestCompletedPage({ limit: 200 });

      expect(page.nextRepo).toBeNull();
      expect(page.reports).toHaveLength(101);
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

  it("lists and marks every report from stale branches through D1 queries", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });

    try {
      for (const [reportId, branch] of [
        ["stale-1", "feature"],
        ["stale-2", "feature"],
        ["protected-1", "main"],
      ] as const) {
        await repository.createOrUpdateDraft({ branch, repo: "qameta/allure-report-storage", reportId });
        await repository.complete(reportId);
      }

      const query = {
        mainBranch: "main",
        maxBranchAgeMs: 24 * 60 * 60 * 1000,
        now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      };
      const candidates = await repository.listStaleBranchReports(query);

      expect(candidates.map((report) => report.id)).toEqual(["stale-1", "stale-2"]);
      const marked = await Promise.all(
        candidates.map((report) => repository.markStaleBranchReportForDeletion(report, query)),
      );

      expect(marked.map((report) => report?.status)).toEqual(["deleting", "deleting"]);
      const mainBranchReport = (await repository.findById("protected-1"))!;

      await expect(repository.markStaleBranchReportForDeletion(mainBranchReport, query)).resolves.toBeNull();
      expect((await repository.listReportsPendingDeletion()).map((report) => report.id)).toEqual([
        "stale-1",
        "stale-2",
      ]);
      expect(await repository.findById("protected-1")).not.toBeNull();
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

      expect(await repository.markRetentionCandidateForDeletion(candidate)).toBeNull();
      expect(await repository.findById("race-1")).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("does not delete a stale branch after it becomes the project main branch", async () => {
    const database = new MemoryD1Database();
    const reports = await D1ReportRepository.create({ database });
    const projects = await D1ProjectRepository.create({ database });

    try {
      await reports.createOrUpdateDraft({
        branch: "feature",
        repo: "qameta/allure-report-storage",
        reportId: "stale-main-race",
      });
      await reports.complete("stale-main-race");

      const query = {
        mainBranch: "main",
        maxBranchAgeMs: 24 * 60 * 60 * 1000,
        now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      };
      const candidate = (await reports.listStaleBranchReports(query))[0]!;

      await projects.upsertMainBranch({ mainBranch: "feature", repo: "qameta/allure-report-storage" });

      await expect(reports.markStaleBranchReportForDeletion(candidate, query)).resolves.toBeNull();
      expect(await reports.findById(candidate.id)).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("allows only the deletion claim owner to remove a report", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });

    try {
      await repository.createOrUpdateDraft({
        branch: "feature",
        repo: "qameta/allure-report-storage",
        reportId: "leased-deletion",
      });
      await repository.complete("leased-deletion");

      const query = {
        mainBranch: "main",
        maxBranchAgeMs: 24 * 60 * 60 * 1000,
        now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      };
      const candidate = (await repository.listStaleBranchReports(query))[0]!;
      const pending = (await repository.markStaleBranchReportForDeletion(candidate, query))!;
      const claim = (await repository.claimReportDeletion(pending))!;

      await expect(repository.claimReportDeletion(pending)).resolves.toBeNull();
      await expect(repository.delete(candidate.id)).resolves.toBe(false);
      await expect(repository.completeReportDeletion({ ...claim, claimId: crypto.randomUUID() })).resolves.toBe(false);
      await expect(repository.completeReportDeletion(claim)).resolves.toBe(true);
      expect(await repository.findById(candidate.id)).toBeNull();
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

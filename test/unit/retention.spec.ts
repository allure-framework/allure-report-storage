import { describe, expect, it, vi } from "vitest";

import type { StaticFileData, StaticFileStore } from "../../src/model.js";
import type { Repositories } from "../../src/repositories/api.js";
import { D1ProjectRepository } from "../../src/repositories/d1/projects.js";
import { D1ReportRepository } from "../../src/repositories/d1/reports.js";
import { SqliteReportRepository } from "../../src/repositories/sqlite/reports.js";
import {
  cleanupReportRetention,
  cleanupReportRetentionScope,
  parseRetentionPolicy,
} from "../../src/utils/retention.js";
import { MemoryD1Database } from "./support/cloudflare.js";

const pauseForOrdering = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

class MemoryFileStore implements StaticFileStore {
  deletedReportIds: string[] = [];
  deletedHistoryIds: string[] = [];

  constructor(private failReportId?: string) {}

  allowDeletes(): void {
    this.failReportId = undefined;
  }

  async put(): Promise<void> {}

  async get(): Promise<Uint8Array<ArrayBuffer> | null> {
    return null;
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async list(): Promise<string[]> {
    return [];
  }

  async delete(reportId: string): Promise<void> {
    if (reportId === this.failReportId) {
      throw new Error("file delete failed");
    }

    this.deletedReportIds.push(reportId);
  }

  async putHistory(_reportId: string, _data: StaticFileData): Promise<void> {}

  async getHistory(): Promise<Uint8Array<ArrayBuffer> | null> {
    return null;
  }

  async deleteHistory(reportId: string): Promise<void> {
    this.deletedHistoryIds.push(reportId);
  }

  async putAsset(): Promise<void> {}

  async getAsset(): Promise<Uint8Array<ArrayBuffer> | null> {
    return null;
  }
}

class BlockingDeleteStore extends MemoryFileStore {
  private deleteCalls = 0;
  private readonly firstDeleteStartedPromise: Promise<void>;
  private readonly releaseFirstDeletePromise: Promise<void>;
  private resolveFirstDeleteStarted!: () => void;
  private resolveReleaseFirstDelete!: () => void;

  constructor() {
    super();
    this.firstDeleteStartedPromise = new Promise((resolve) => {
      this.resolveFirstDeleteStarted = resolve;
    });
    this.releaseFirstDeletePromise = new Promise((resolve) => {
      this.resolveReleaseFirstDelete = resolve;
    });
  }

  async delete(reportId: string): Promise<void> {
    this.deleteCalls += 1;

    if (this.deleteCalls === 1) {
      this.resolveFirstDeleteStarted();
      await this.releaseFirstDeletePromise;
    }

    await super.delete(reportId);
  }

  async waitForFirstDelete(): Promise<void> {
    await this.firstDeleteStartedPromise;
  }

  releaseFirstDelete(): void {
    this.resolveReleaseFirstDelete();
  }
}

class PartiallyFailingDeleteStore extends BlockingDeleteStore {
  private failHistory = true;

  async deleteHistory(reportId: string): Promise<void> {
    if (this.failHistory) {
      this.failHistory = false;
      throw new Error("history delete failed");
    }

    await super.deleteHistory(reportId);
  }
}

describe("report retention", () => {
  it("removes every completed report from stale unprotected branches", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });
    const projects = await D1ProjectRepository.create({ database });
    const fileStore = new MemoryFileStore();
    const repo = "qameta/allure-report-storage";

    try {
      for (const [reportId, branch] of [
        ["feature-1", "feature"],
        ["feature-2", "feature"],
        ["main-1", "main"],
        ["trunk-1", "trunk"],
        ["release-1", "release"],
      ] as const) {
        await repository.createOrUpdateDraft({ branch, repo, reportId });
        await repository.complete(reportId);
      }

      await projects.upsertMainBranch({ mainBranch: "trunk", repo });
      database.preparedQueries.length = 0;

      const repositories = { projects, reports: repository } as Repositories;
      const deletedIds = await cleanupReportRetention({
        fileStore,
        mainBranch: "main",
        now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        policy: {
          protectedBranches: ["release"],
          staleBranchAgeMs: 24 * 60 * 60 * 1000,
        },
        repositories,
      });

      expect(deletedIds).toEqual(["feature-1", "feature-2"]);
      expect(await repository.findById("feature-1")).toBeNull();
      expect(await repository.findById("feature-2")).toBeNull();
      expect(await repository.findById("main-1")).not.toBeNull();
      expect(await repository.findById("trunk-1")).not.toBeNull();
      expect(await repository.findById("release-1")).not.toBeNull();
      expect(fileStore.deletedReportIds).toEqual(["feature-1", "feature-2"]);
      expect(fileStore.deletedHistoryIds).toEqual(["feature-1", "feature-2"]);
      expect(
        database.preparedQueries.filter((query) => /^\s*select\s+\*\s+from\s+["`]?projects\b/i.test(query)),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("continues cleanup when one candidate file delete fails", async () => {
    const repository = await SqliteReportRepository.create({ databasePath: ":memory:" });
    const fileStore = new MemoryFileStore("retention-2");

    try {
      for (const reportId of ["retention-1", "retention-2", "retention-3"] as const) {
        await repository.createOrUpdateDraft({ branch: "main", repo: "qameta/allure-report-storage", reportId });
        await repository.complete(reportId);
        await pauseForOrdering();
      }

      await expect(
        cleanupReportRetentionScope({
          branch: "main",
          fileStore,
          policy: { maxReportsPerBranch: 1 },
          repo: "qameta/allure-report-storage",
          reportsRepository: repository,
        }),
      ).rejects.toThrow("report retention cleanup failed");

      expect(await repository.findById("retention-1")).toBeNull();
      expect(await repository.findById("retention-2")).toBeNull();
      expect(await repository.findById("retention-3")).not.toBeNull();
      expect(fileStore.deletedReportIds).toEqual(["retention-1"]);

      fileStore.allowDeletes();

      await cleanupReportRetention({
        fileStore,
        policy: { maxReportsPerBranch: 1 },
        repositories: { reports: repository } as Repositories,
      });

      expect(fileStore.deletedReportIds).toEqual(["retention-1", "retention-2"]);
    } finally {
      await repository.close();
    }
  });

  it("retries storage cleanup for the last report on a stale branch", async () => {
    const database = new MemoryD1Database();
    const repository = await D1ReportRepository.create({ database });
    const fileStore = new MemoryFileStore("stale-retry");
    const repositories = { reports: repository } as Repositories;
    const retention = {
      fileStore,
      mainBranch: "main",
      now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      policy: { staleBranchAgeMs: 24 * 60 * 60 * 1000 },
      repositories,
    };

    try {
      await repository.createOrUpdateDraft({
        branch: "feature",
        repo: "qameta/allure-report-storage",
        reportId: "stale-retry",
      });
      await repository.complete("stale-retry");

      await expect(cleanupReportRetention(retention)).rejects.toThrow("report retention cleanup failed");
      expect((await repository.listReportsPendingDeletion()).map((report) => report.id)).toEqual(["stale-retry"]);

      fileStore.allowDeletes();

      await expect(cleanupReportRetention(retention)).resolves.toEqual(["stale-retry"]);
      expect(await repository.listReportsPendingDeletion()).toEqual([]);
      expect(fileStore.deletedReportIds).toEqual(["stale-retry"]);
    } finally {
      database.close();
    }
  });

  it("keeps a report id reserved while another cleanup owns its deletion", async () => {
    const repository = await SqliteReportRepository.create({ databasePath: ":memory:" });
    const fileStore = new BlockingDeleteStore();
    const repo = "qameta/allure-report-storage";
    let freshCleanup: Promise<string[]> | undefined;

    try {
      for (const reportId of ["claimed-1", "claimed-2"] as const) {
        await repository.createOrUpdateDraft({ branch: "main", repo, reportId });
        await repository.complete(reportId);
        await pauseForOrdering();
      }

      freshCleanup = cleanupReportRetentionScope({
        branch: "main",
        fileStore,
        policy: { maxReportsPerBranch: 1 },
        repo,
        reportsRepository: repository,
      });

      await fileStore.waitForFirstDelete();

      await expect(
        cleanupReportRetention({
          fileStore,
          policy: { maxReportsPerBranch: 1 },
          repositories: { reports: repository } as Repositories,
        }),
      ).resolves.toEqual([]);
      await expect(
        repository.createOrUpdateDraft({ branch: "main", repo, reportId: "claimed-1" }),
      ).resolves.toMatchObject({ conflict: true });

      fileStore.releaseFirstDelete();
      await expect(freshCleanup).resolves.toEqual(["claimed-1"]);
      await expect(
        repository.createOrUpdateDraft({ branch: "main", repo, reportId: "claimed-1" }),
      ).resolves.toMatchObject({ conflict: false });
      expect(await repository.findById("claimed-1")).toMatchObject({ status: "draft" });
    } finally {
      fileStore.releaseFirstDelete();
      await freshCleanup?.catch(() => undefined);
      await repository.close();
    }
  });

  it("keeps the claim until every storage deletion settles and retries pending work without a policy", async () => {
    const repository = await SqliteReportRepository.create({ databasePath: ":memory:" });
    const fileStore = new PartiallyFailingDeleteStore();
    const repo = "qameta/allure-report-storage";
    let cleanup: Promise<string[]> | undefined;

    try {
      for (const reportId of ["partial-1", "partial-2"] as const) {
        await repository.createOrUpdateDraft({ branch: "main", repo, reportId });
        await repository.complete(reportId);
        await pauseForOrdering();
      }

      cleanup = cleanupReportRetentionScope({
        branch: "main",
        fileStore,
        policy: { maxReportsPerBranch: 1 },
        repo,
        reportsRepository: repository,
      });

      await fileStore.waitForFirstDelete();

      const claimed = (await repository.listReportsPendingDeletion())[0]!;

      expect(claimed.status).toBe("deleting_claimed");
      await expect(repository.claimReportDeletion(claimed)).resolves.toBeNull();

      fileStore.releaseFirstDelete();
      await expect(cleanup).rejects.toThrow("report retention cleanup failed");
      expect((await repository.listReportsPendingDeletion())[0]?.status).toBe("deleting");

      await expect(
        cleanupReportRetention({
          fileStore,
          policy: {},
          repositories: { reports: repository } as Repositories,
        }),
      ).resolves.toEqual(["partial-1"]);
    } finally {
      fileStore.releaseFirstDelete();
      await cleanup?.catch(() => undefined);
      await repository.close();
    }
  });

  it("retries pending cleanup even when fresh candidate cleanup fails", async () => {
    const repository = await SqliteReportRepository.create({ databasePath: ":memory:" });
    const fileStore = new MemoryFileStore("fresh-1");
    const repo = "qameta/allure-report-storage";

    try {
      for (const [reportId, branch] of [
        ["pending-1", "pending"],
        ["pending-2", "pending"],
        ["fresh-1", "fresh"],
        ["fresh-2", "fresh"],
      ] as const) {
        await repository.createOrUpdateDraft({ branch, repo, reportId });
        await repository.complete(reportId);
        await pauseForOrdering();
      }

      const pendingCandidate = (
        await repository.listRetentionCandidates({ branch: "pending", maxReportsPerBranch: 1, repo })
      )[0]!;

      await repository.markRetentionCandidateForDeletion(pendingCandidate);

      await expect(
        cleanupReportRetention({
          fileStore,
          policy: { maxReportsPerBranch: 1 },
          repositories: { reports: repository } as Repositories,
        }),
      ).rejects.toThrow("report retention cleanup failed");
      expect(fileStore.deletedReportIds).toContain("pending-1");
      expect(await repository.listReportsPendingDeletion()).not.toContainEqual(
        expect.objectContaining({ id: "pending-1" }),
      );
    } finally {
      await repository.close();
    }
  });

  it("runs later cleanup phases and aggregates candidate query failures", async () => {
    const repository = await SqliteReportRepository.create({ databasePath: ":memory:" });
    const fileStore = new MemoryFileStore();
    const repo = "qameta/allure-report-storage";

    try {
      await repository.createOrUpdateDraft({ branch: "stale", repo, reportId: "stale-query" });
      await repository.complete("stale-query");

      vi.spyOn(repository, "listReportsPendingDeletion").mockRejectedValueOnce(new Error("pending query failed"));
      vi.spyOn(repository, "listRetentionCandidates").mockRejectedValueOnce(new Error("fresh query failed"));

      const error = await cleanupReportRetention({
        fileStore,
        mainBranch: "main",
        now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        policy: { maxReportsPerBranch: 1, staleBranchAgeMs: 24 * 60 * 60 * 1000 },
        repositories: { reports: repository } as Repositories,
      }).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        expect.objectContaining({ message: "pending query failed" }),
        expect.objectContaining({ message: "fresh query failed" }),
      ]);
      expect(await repository.findById("stale-query")).toBeNull();
    } finally {
      await repository.close();
    }
  });

  it("rejects retention age values outside supported Date range after conversion", () => {
    expect(() =>
      parseRetentionPolicy((name) => (name === "REPORT_RETENTION_MAX_REPORT_AGE_DAYS" ? "1e20" : undefined)),
    ).toThrow("REPORT_RETENTION_MAX_REPORT_AGE_DAYS must fit in supported Date range");
  });

  it("parses stale branch retention and normalizes protected branches", () => {
    const values: Record<string, string> = {
      REPORT_RETENTION_PROTECTED_BRANCHES: " main, release ,main,, dev ",
      REPORT_RETENTION_STALE_BRANCH_DAYS: "2.5",
    };

    expect(parseRetentionPolicy((name) => values[name])).toEqual({
      protectedBranches: ["main", "release", "dev"],
      staleBranchAgeMs: 2.5 * 24 * 60 * 60 * 1000,
    });
  });

  it("rejects invalid stale branch age values", () => {
    expect(() =>
      parseRetentionPolicy((name) => (name === "REPORT_RETENTION_STALE_BRANCH_DAYS" ? "0" : undefined)),
    ).toThrow("REPORT_RETENTION_STALE_BRANCH_DAYS must be a positive number");

    expect(() =>
      parseRetentionPolicy((name) => (name === "REPORT_RETENTION_STALE_BRANCH_DAYS" ? "1e20" : undefined)),
    ).toThrow("REPORT_RETENTION_STALE_BRANCH_DAYS must fit in supported Date range");
  });
});

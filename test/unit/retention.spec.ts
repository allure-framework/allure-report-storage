import { describe, expect, it } from "vitest";

import type { StaticFileData, StaticFileStore } from "../../src/model.js";
import type { Repositories } from "../../src/repositories/api.js";
import { SqliteReportRepository } from "../../src/repositories/sqlite/reports.js";
import {
  cleanupReportRetention,
  cleanupReportRetentionScope,
  parseRetentionPolicy,
} from "../../src/utils/retention.js";

const pauseForOrdering = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

class MemoryFileStore implements StaticFileStore {
  deletedReportIds: string[] = [];
  deletedHistoryIds: string[] = [];

  constructor(private readonly failReportId?: string) {}

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

describe("report retention", () => {
  it("removes every completed report from stale unprotected branches", async () => {
    const repository = await SqliteReportRepository.create({ databasePath: ":memory:" });
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

      const repositories = {
        projects: {
          findByRepo: async () => ({ mainBranch: "trunk", repo }),
        },
        reports: repository,
      } as Repositories;
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
    } finally {
      await repository.close();
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

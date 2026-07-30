import { describe, expect, it } from "vitest";

import type { StaticFileData, StaticFileStore } from "../../src/model.js";
import { SqliteReportRepository } from "../../src/repositories/sqlite/reports.js";
import { cleanupReportRetentionScope, parseRetentionPolicy } from "../../src/utils/retention.js";

const pauseForOrdering = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

class MemoryFileStore implements StaticFileStore {
  deletedReportIds: string[] = [];

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

  async deleteHistory(): Promise<void> {}

  async putAsset(): Promise<void> {}

  async getAsset(): Promise<Uint8Array<ArrayBuffer> | null> {
    return null;
  }
}

describe("report retention", () => {
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
});

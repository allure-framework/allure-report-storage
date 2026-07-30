import { describe, expect, it } from "vitest";

import { SqliteProjectRepository } from "../../../src/repositories/sqlite/projects.js";

describe("SqliteProjectRepository", () => {
  it("stores project main branch metadata", async () => {
    const repository = await SqliteProjectRepository.create({ databasePath: ":memory:" });

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
      await repository.close();
    }
  });
});

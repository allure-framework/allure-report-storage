import type { Report, StaticFileStore } from "../model.js";
import type { ListHistoryQuery, ReportRepository } from "../repositories/api.js";

const textDecoder = new TextDecoder();

const deleteReportAndFiles = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  report: Report,
): Promise<void> => {
  await reportsRepository.delete(report.id);
  await Promise.all([fileStore.delete(report.id), fileStore.deleteHistory(report.id)]);
};

export const readHistoryDataPoint = async (
  fileStore: StaticFileStore,
  report: Report,
): Promise<unknown | undefined> => {
  const dataPoint = await fileStore.getHistory(report.id);

  if (!dataPoint) {
    return undefined;
  }

  try {
    return JSON.parse(textDecoder.decode(dataPoint));
  } catch {
    return undefined;
  }
};

export const listCompleteHistory = async (
  reportsRepository: ReportRepository,
  query: ListHistoryQuery & { limit: number },
): Promise<Report[]> => {
  let scanLimit = query.limit;
  let reports = await reportsRepository.listHistory({ ...query, limit: scanLimit });

  while (reports.length === scanLimit && scanLimit < Number.MAX_SAFE_INTEGER) {
    scanLimit = Math.min(scanLimit * 2, Number.MAX_SAFE_INTEGER);
    reports = await reportsRepository.listHistory({ ...query, limit: scanLimit });
  }

  return reports;
};

export const resolveHistoryDataPoints = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  reports: Report[],
  branch: string,
): Promise<unknown[]> => {
  const history: unknown[] = [];

  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index]!;
    const dataPoint = await readHistoryDataPoint(fileStore, report);

    if (!dataPoint) {
      const reportsToDelete = (history.length === 0 ? [report] : reports.slice(index)).filter(
        (item) => item.branch === branch,
      );

      await Promise.all(reportsToDelete.map((item) => deleteReportAndFiles(fileStore, reportsRepository, item)));

      if (history.length > 0) {
        break;
      }

      continue;
    }

    history.push(dataPoint);
  }

  return history;
};

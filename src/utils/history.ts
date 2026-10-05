import type { Report, StaticFileStore } from "../model.js";
import type { ListHistoryQuery, ReportRepository } from "../repositories/api.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const historyPrefix = textEncoder.encode('{"history":[');
const historySeparator = textEncoder.encode(",");
const historySuffix = textEncoder.encode("]}");

const deleteReportAndFiles = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  report: Report,
): Promise<void> => {
  await Promise.all([fileStore.delete(report.id), fileStore.deleteHistory(report.id)]);
  await reportsRepository.delete(report.id);
};

export const readSerializedHistoryDataPoint = async (
  fileStore: StaticFileStore,
  report: Report,
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const dataPoint = await fileStore.getHistory(report.id);

  if (!dataPoint) {
    return undefined;
  }

  try {
    JSON.parse(textDecoder.decode(dataPoint));

    return dataPoint;
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

export const resolveSerializedHistoryDataPoints = async (
  fileStore: StaticFileStore,
  reportsRepository: ReportRepository,
  reports: Report[],
  branch: string,
): Promise<Uint8Array<ArrayBuffer>[]> => {
  const history: Uint8Array<ArrayBuffer>[] = [];

  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index]!;
    const dataPoint = await readSerializedHistoryDataPoint(fileStore, report);

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

export const createHistoryResponse = (history: readonly Uint8Array<ArrayBuffer>[]): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(historyPrefix);

      history.forEach((dataPoint, index) => {
        if (index > 0) {
          controller.enqueue(historySeparator);
        }

        controller.enqueue(dataPoint);
      });

      controller.enqueue(historySuffix);
      controller.close();
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/json; charset=UTF-8" },
    status: 200,
  });
};

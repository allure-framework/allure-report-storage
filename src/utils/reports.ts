import type { Project, Report } from "../model.js";

const htmlEscapeMap: Record<string, string> = {
  "&": "&amp;",
  "'": "&#39;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

const reportLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 32 32">
    <g clip-path="url(#a)">
        <path fill="url(#b)" fill-rule="evenodd"
            d="M22.23 4.66a3.6 3.6 0 0 1 5.1.04A16.08 16.08 0 0 1 31.97 16a3.6 3.6 0 1 1-7.2 0c0-2.4-.98-4.61-2.58-6.24a3.6 3.6 0 0 1 .03-5.1Z"
            clip-rule="evenodd" />
        <path fill="url(#c)" fill-rule="evenodd"
            d="M12.4 3.6A3.6 3.6 0 0 1 16 0c4.4 0 8.4 1.8 11.29 4.66a3.6 3.6 0 0 1-5.06 5.13A8.87 8.87 0 0 0 16 7.2a3.6 3.6 0 0 1-3.6-3.6Z"
            clip-rule="evenodd" />
        <path fill="url(#d)" fill-rule="evenodd"
            d="M0 16A16 16 0 0 1 16 0a3.6 3.6 0 0 1 0 7.2 8.8 8.8 0 0 0-6.21 15.04 3.6 3.6 0 0 1-5.13 5.06A16.08 16.08 0 0 1 0 16Z"
            clip-rule="evenodd" />
        <path fill="url(#e)" fill-rule="evenodd"
            d="M4.66 22.24a3.6 3.6 0 0 1 5.1-.03 8.87 8.87 0 0 0 6.23 2.59 3.6 3.6 0 0 1 0 7.2c-4.4 0-8.4-1.8-11.3-4.66a3.6 3.6 0 0 1-.03-5.1Z"
            clip-rule="evenodd" />
        <path fill="url(#f)" fill-rule="evenodd"
            d="M28.38 12.4a3.6 3.6 0 0 1 3.6 3.6A16 16 0 0 1 16 32a3.6 3.6 0 0 1 0-7.2 8.8 8.8 0 0 0 8.8-8.8 3.6 3.6 0 0 1 3.6-3.6Z"
            clip-rule="evenodd" />
        <path fill="url(#g)" fill-rule="evenodd"
            d="M28.38 12.4a3.6 3.6 0 0 1 3.6 3.6v12.4a3.6 3.6 0 1 1-7.2 0V16a3.6 3.6 0 0 1 3.6-3.6Z"
            clip-rule="evenodd" />
        <g clip-path="url(#h)">
            <path fill="url(#i)" fill-rule="evenodd"
                d="M22.23 4.66a3.6 3.6 0 0 1 5.1.04A16.08 16.08 0 0 1 31.97 16a3.6 3.6 0 1 1-7.2 0c0-2.4-.98-4.61-2.58-6.24a3.6 3.6 0 0 1 .03-5.1Z"
                clip-rule="evenodd" />
        </g>
    </g>
    <defs>
        <linearGradient id="b" x1="26.4" x2="28.8" y1="9.6" y2="15.01" gradientUnits="userSpaceOnUse">
            <stop stop-color="#7E22CE" />
            <stop offset="1" stop-color="#8B5CF6" />
        </linearGradient>
        <linearGradient id="c" x1="26.8" x2="17.8" y1="9.4" y2="3.61" gradientUnits="userSpaceOnUse">
            <stop stop-color="#EF4444" />
            <stop offset="1" stop-color="#DC2626" />
        </linearGradient>
        <linearGradient id="d" x1="3.6" x2="5.4" y1="14.01" y2="24.81" gradientUnits="userSpaceOnUse">
            <stop stop-color="#22C55E" />
            <stop offset="1" stop-color="#15803D" />
        </linearGradient>
        <linearGradient id="e" x1="4.8" x2="14.4" y1="22.21" y2="29.21" gradientUnits="userSpaceOnUse">
            <stop stop-color="#94A3B8" />
            <stop offset=".96" stop-color="#64748B" />
            <stop offset="1" stop-color="#64748B" />
        </linearGradient>
        <linearGradient id="f" x1="28.4" x2="22.19" y1="22.18" y2="28.4" gradientUnits="userSpaceOnUse">
            <stop stop-color="#D97706" />
            <stop offset="1" stop-color="#FBBF24" />
        </linearGradient>
        <linearGradient id="g" x1="29.2" x2="30.63" y1="54.43" y2="54.28" gradientUnits="userSpaceOnUse">
            <stop stop-color="#FBBF24" />
            <stop offset="1" stop-color="#FBBF24" />
        </linearGradient>
        <linearGradient id="i" x1="26.4" x2="28.8" y1="9.6" y2="15.01" gradientUnits="userSpaceOnUse">
            <stop stop-color="#7E22CE" />
            <stop offset="1" stop-color="#8B5CF6" />
        </linearGradient>
        <clipPath id="a">
            <path fill="#fff" d="M0 0h32v32H0z" />
        </clipPath>
        <clipPath id="h">
            <path fill="#fff" d="M24.8 12H32v8h-7.2z" />
        </clipPath>
    </defs>
</svg>`;

const escapeHtml = (value: string): string => value.replace(/[&"'<>]/g, (character) => htmlEscapeMap[character]);

const reportCreatedAtFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  hour12: true,
  minute: "2-digit",
  month: "long",
  second: "2-digit",
  timeZone: "UTC",
  year: "numeric",
});

export const formatReportCreatedAt = (createdAt: string): string => {
  const parts: Record<string, string> = {};

  for (const { type, value } of reportCreatedAtFormatter.formatToParts(new Date(createdAt))) {
    parts[type] = value;
  }

  return `${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod}`;
};

const groupReportsByBranch = (reports: Report[]): Map<string, Report[]> => {
  const groupedReports = new Map<string, Report[]>();

  for (const report of reports) {
    const branchReports = groupedReports.get(report.branch);

    if (branchReports) {
      branchReports.push(report);
      continue;
    }

    groupedReports.set(report.branch, [report]);
  }

  return groupedReports;
};

const renderReportItem = (report: Report): string =>
  `<li><a href="${escapeHtml(buildReportUrl(report.id))}" target="_blank">${escapeHtml(report.id)}</a> <time datetime="${escapeHtml(report.createdAt)}">${escapeHtml(formatReportCreatedAt(report.createdAt))}</time></li>`;

const renderBranchNode = (label: string, childrenHtml: string): string =>
  `<li><strong>${escapeHtml(label)}</strong><ul>${childrenHtml}</ul></li>`;

export const mapReport = (report: Report) => ({
  id: report.id,
  repo: report.repo,
  branch: report.branch,
  name: report.name,
  status: report.status,
  createdAt: report.createdAt,
  updatedAt: report.updatedAt,
  completedAt: report.completedAt,
});

export const mapProject = (project: Project) => ({
  mainBranch: project.mainBranch,
  repo: project.repo,
});

export const buildReportUrl = (reportId: string): string => `/${encodeURIComponent(reportId)}`;

export const buildReportFileUrl = (reportId: string, ...segments: string[]): string =>
  `${buildReportUrl(reportId)}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;

export const createReportId = (): string => crypto.randomUUID();

export const renderReportsTreePage = (input: { mainBranch: string; repo: string; reports: Report[] }): string => {
  const groupedReports = groupReportsByBranch(input.reports);
  const mainBranchReports = groupedReports.get(input.mainBranch) ?? [];
  const childBranches = Array.from(groupedReports.keys())
    .filter((branch) => branch !== input.mainBranch)
    .sort((left, right) => left.localeCompare(right));

  const treeHtml = renderBranchNode(
    input.mainBranch,
    [
      ...mainBranchReports.map(renderReportItem),
      ...childBranches.map((branch) =>
        renderBranchNode(branch, (groupedReports.get(branch) ?? []).map(renderReportItem).join("")),
      ),
    ].join(""),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
html, body {
  min-height: 100%;
}

body {
  margin: 0;
  padding: 24px;
  background: #f1f5f7ff;
  font-family: "JetBrainsMonoVF", ui-monospace, monospace;
  color: #010a18d4;
}

a {
  color: inherit;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

main {
  overflow-x: auto;
  font-size: 14px;
}

.logo {
  margin-bottom: 24px;
}

.logo svg {
  display: block;
  width: 32px;
  height: 32px;
}

time {
  color: #011228ad;
}

ul {
  margin: 0;
  padding-left: 16px;
}
</style>
</head>
<body>
<main>
<div class="logo">${reportLogoSvg}</div>
<ul>${treeHtml}</ul>
</main>
</body>
</html>`;
};

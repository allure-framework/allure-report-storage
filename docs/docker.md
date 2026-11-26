# Docker

Use the Allure Report Storage service with Docker or Docker Compose.

[<img src="https://allurereport.org/public/img/allure-report.svg" height="85px" alt="Allure Report logo" align="right" />](https://allurereport.org "Allure Report")

- Learn more about Allure Report at https://allurereport.org
- 📚 [Documentation](https://allurereport.org/docs/) – discover official documentation for Allure Report
- ❓ [Questions and Support](https://github.com/orgs/allure-framework/discussions/categories/questions-support) – get help from the team and community
- 📢 [Official annoucements](https://github.com/orgs/allure-framework/discussions/categories/announcements) – be in touch with the latest updates
- 💬 [General Discussion](https://github.com/orgs/allure-framework/discussions/categories/general-discussion)  – engage in casual conversations, share insights and ideas with the community

## Requirements

- Docker
- Docker Compose

## Start with Docker Compose

- Create a `compose.yaml` file. The service uses the published
  [`allure/allure-report-storage`](https://hub.docker.com/r/allure/allure-report-storage) image, so cloning this repository or building the image locally is not required.

  ```yaml
  services:
    app:
      image: allure/allure-report-storage:v1.0.0
      environment:
        ACCESS_TOKEN: ${ACCESS_TOKEN:-change-me}
        DATABASE_PATH: /data/reports.sqlite
        DATA_DIR: /data
        HOST: 0.0.0.0
        MAIN_BRANCH: ${MAIN_BRANCH:-main}
        PORT: 3000
        PUBLIC_URL: ${PUBLIC_URL:-}
        SECRET: ${SECRET:-change-me-secret}
      ports:
        - "3000:3000"
      restart: unless-stopped
      volumes:
        - report-data:/data

  volumes:
    report-data:
  ```

- Set `ACCESS_TOKEN` and `SECRET` to secure values. `ACCESS_TOKEN` is the bootstrap bearer token for `POST /api/token`; `SECRET` signs generated access tokens.
- If TLS terminates at a reverse proxy, set `PUBLIC_URL=https://reports.example.com` in the Compose environment (for example, in its `.env` file) before generating tokens. It overrides only the origin embedded in new tokens; see [Public URL](../README.md#public-url) for validation rules and token replacement steps.
- Start the published image:

  ```bash
  docker compose up -d
  ```

## Start the current checkout

Use the development override to build and run the service from the current repository checkout instead of the
published image:

```bash
docker compose -f compose.yaml -f compose-dev.yaml up --build
```

## S3-Compatible Storage

Use `STORAGE_BACKEND=s3` env variable if you want to use S3 storage instead of file system with:

```bash
STORAGE_BACKEND=s3
S3_BUCKET=allure-report-storage
S3_REGION=us-east-1
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
```

Required vars: `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`.

If `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` are not set, the AWS SDK default credential provider chain is used.

Optional vars: `S3_PREFIX`, `S3_REPORTS_PREFIX`, `S3_ASSETS_PREFIX`, `S3_SESSION_TOKEN`.

For Cloudflare R2, use `S3_REGION=auto`, `S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com`, and `S3_FORCE_PATH_STYLE=false`.
Bucket-specific R2 endpoints are normalized internally.

## Compressed report files in SQLite

A report consists of thousands of small JSON files. On a filesystem with 4 KB blocks each of them takes a full block, so a report takes about twice its size on disk. Use `REPORT_FILES_STORE=sqlite` to keep report files and history points gzipped in a SQLite database instead:

```bash
REPORT_FILES_STORE=sqlite
REPORT_FILES_DATABASE_PATH=/data/report-files.sqlite
```

- `REPORT_FILES_DATABASE_PATH`: optional, defaults to `<DATA_DIR>/report-files.sqlite`.
- Shared assets and files larger than 8 MB stay in the configured storage backend (file system or S3).
- Reports published before the option was enabled stay readable from the storage backend, so no migration is needed.
- Reports published while the option is enabled live only in the database. Turning it off again makes them unreadable, so keep it enabled until retention has removed them.
- Deleting a report runs an incremental vacuum, so freed space is returned to the volume.
- Files are served decompressed; clients see no difference.

With a report of 1679 tests (3497 files), one report took 20.4 MB on the file system and 4.3 MB with this option, with the same upload time.

## Report retention

Automated retention can delete old reports to reduce disk or S3 storage costs. It is disabled by default and enabled only when at least one retention age or count env var is set:

```bash
REPORT_RETENTION_MAX_REPORTS_PER_BRANCH=20
REPORT_RETENTION_MAX_REPORT_AGE_DAYS=30
REPORT_RETENTION_STALE_BRANCH_DAYS=30
REPORT_RETENTION_PROTECTED_BRANCHES=main,master,dev
```

- `REPORT_RETENTION_MAX_REPORTS_PER_BRANCH`: keep newest completed reports per branch up to this positive integer limit, delete older ones.
- `REPORT_RETENTION_MAX_REPORT_AGE_DAYS`: delete reports older than this positive number of days. The newest completed report per branch is always preserved.
- `REPORT_RETENTION_STALE_BRANCH_DAYS`: during background sweeps, delete all completed reports and stored report data for a branch when its newest completed report is older than this positive number of days.
- `REPORT_RETENTION_PROTECTED_BRANCHES`: optional comma-separated branch names that stale-branch retention must preserve, such as `main,master,dev`.

The default or project-specific main branch is always protected from stale-branch retention. All strategies can be enabled together. The Docker service runs count/age retention after report completion and all retention strategies on an hourly background sweep. Retention does not change public history download limits or manual delete behavior.

## Validate via GET /api/ping

```bash
curl http://localhost:3000/api/ping
```

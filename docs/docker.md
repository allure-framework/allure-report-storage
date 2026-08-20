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
- Start the published image:

  ```bash
  docker compose up -d
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

## Report retention

Automated retention can delete old reports to reduce disk or S3 storage costs. It is disabled by default and enabled only when at least one env var is set:

```bash
REPORT_RETENTION_MAX_REPORTS_PER_BRANCH=20
REPORT_RETENTION_MAX_REPORT_AGE_DAYS=30
```

- `REPORT_RETENTION_MAX_REPORTS_PER_BRANCH`: keep newest completed reports per branch up to this positive integer limit, delete older ones.
- `REPORT_RETENTION_MAX_REPORT_AGE_DAYS`: delete reports older than this positive number of days. The newest completed report per branch is always preserved.

Both strategies can be enabled together. The Docker service runs retention after report completion and on an hourly background sweep. Retention does not change public history download limits or manual delete behavior.

## Validate via GET /api/ping

```bash
curl http://localhost:3000/api/ping
```

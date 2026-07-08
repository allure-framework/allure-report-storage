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

- Add the required env vars directly in `compose.yaml` (or override them there); the compose file already defines defaults for `ACCESS_TOKEN` and `SECRET`.
- `ACCESS_TOKEN` is the bootstrap bearer token for `POST /api/token`.
- `SECRET` is the signing secret for generated access tokens.
- Start the service:

  ```bash
  docker compose up --build
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

## Validate via GET /api/ping

```bash
curl http://localhost:3000/api/ping
```

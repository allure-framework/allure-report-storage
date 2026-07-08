# Cloudflare

Use Allure Report Storage as a Cloudflare Worker.

[<img src="https://allurereport.org/public/img/allure-report.svg" height="85px" alt="Allure Report logo" align="right" />](https://allurereport.org "Allure Report")

- Learn more about Allure Report at https://allurereport.org
- 📚 [Documentation](https://allurereport.org/docs/) – discover official documentation for Allure Report
- ❓ [Questions and Support](https://github.com/orgs/allure-framework/discussions/categories/questions-support) – get help from the team and community
- 📢 [Official annoucements](https://github.com/orgs/allure-framework/discussions/categories/announcements) – be in touch with the latest updates
- 💬 [General Discussion](https://github.com/orgs/allure-framework/discussions/categories/general-discussion)  – engage in casual conversations, share insights and ideas with the community

## Requirements

- Cloudflare account with a D1 database and an R2 bucket
- `wrangler.toml` updated with your D1 `database_id`
- The R2 bucket name must match `bucket_name` in `wrangler.toml` (`allure-report-storage`) or be updated there
- Worker vars or secrets: `ACCESS_TOKEN` and `SECRET`

The Worker uses D1 + R2 by default. [S3-compatible storage](#s3-compatible_storage) is an alternative backend for report files/assets.

## Deploy or start

1. Create the Cloudflare resources:

   ```bash
   corepack enable
   yarn dlx wrangler d1 create allure-report-storage
   yarn dlx wrangler r2 bucket create allure-report-storage
   ```

2. Update `database_id` in `wrangler.toml`.
3. Set `ACCESS_TOKEN` and `SECRET` as vars or Worker secrets.
4. Deploy the Worker:

   ```bash
   corepack enable
   yarn dlx wrangler deploy
   ```

5. Start locally if needed:

   ```bash
   corepack enable
   yarn dlx wrangler dev
   ```

## S3-Compatible Storage

Use `STORAGE_BACKEND=s3` instead of filesystem storage.

Required vars: `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`.

If `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` are not set, the AWS SDK default credential provider chain is used.

Optional vars: `S3_PREFIX`, `S3_REPORTS_PREFIX`, `S3_ASSETS_PREFIX`, `S3_SESSION_TOKEN`.

Cloudflare R2 example:

```bash
STORAGE_BACKEND=s3
S3_BUCKET=allure-report-storage
S3_REGION=auto
S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<access-key>
S3_SECRET_ACCESS_KEY=<secret-key>
S3_FORCE_PATH_STYLE=false
```

Bucket-specific R2 endpoints are normalized internally.

## Validate via GET /api/ping

```bash
curl https://<your-worker-domain>/api/ping
```

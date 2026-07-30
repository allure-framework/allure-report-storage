# Allure Report Storage

The Allure Report Storage service allows to publish Allure Report reports to and seamlessly integrates with history feature, making possible to see previous reports in a single click.

[<img src="https://allurereport.org/public/img/allure-report.svg" height="85px" alt="Allure Report logo" align="right" />](https://allurereport.org "Allure Report")

- Learn more about Allure Report at https://allurereport.org
- 📚 [Documentation](https://allurereport.org/docs/) – discover official documentation for Allure Report
- ❓ [Questions and Support](https://github.com/orgs/allure-framework/discussions/categories/questions-support) – get help from the team and community
- 📢 [Official annoucements](https://github.com/orgs/allure-framework/discussions/categories/announcements) – be in touch with the latest updates
- 💬 [General Discussion](https://github.com/orgs/allure-framework/discussions/categories/general-discussion)  – engage in casual conversations, share insights and ideas with the community

## Usage

![Allure Report Storage service preview](./public/cover.png)

The service integrates seamlessly with Allure3, you just need to do these 4 simple steps:

1. Run the service using it [inside Docker](#docker) or as [a Cloudflare worker](#cloudflare)
2. Generate access token [using REST API](#access-token-generation)
3. Add token to the Allure runtime config
4. Add `publish` flag to the options of reports which should be published

## Installation

### Docker

Continue reading [here](./docs/docker.md).

### Cloudflare

Continue reading [here](./docs/cloudflare.md).

## Usage

### Access token generation

Generate access token using the Storage API first (use access token previously passed to the service env variable):

```bash
curl -sS -X POST http://localhost:3000/api/token \
  -H "Authorization: Bearer storage_bootstrap_token"
```

Then use it in the Allure Report runtime config:

```diff
import { defineConfig } from "allure";

export default defineConfig({
  name: "Allure Report",
  plugins: {
    awesome: {
      options: {
+       publish: true, // explicitly specify which reports should be published
      },
    },
  },
+  allureService: {
+    accessToken: "ars1...",
+  },
});
```

### Main branch selection

If your main branch doesn't call `main`, you can specify a custom one to compare reports from another branches with:

```bash
curl -sS -X POST http://localhost:3000/api/projects/main-branch \
  -H "Authorization: Bearer storage_bootstrap_token" \
  -H "Content-Type: application/json" \
  -d '{ "repo": "repo_name", "main_branch": "main_branch_name"}'
```

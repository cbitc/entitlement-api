# Keycloak（本地开发用 IdP）

`docker compose up -d` 会一并启动 Keycloak（`entitlement-api-keycloak`），
realm 定义在 `entitlement-realm.json`，**只在数据卷为空时导入一次**。

## 地址

| 用途                               | 地址                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| Issuer（对接 API 的 `SSO_ISSUER`） | http://localhost:8080/realms/entitlement                                  |
| 管理控制台                         | http://localhost:8080/admin （admin / admin）                             |
| Discovery                          | http://localhost:8080/realms/entitlement/.well-known/openid-configuration |

## 预置客户端

- `entitlement-api`：confidential，Authorization Code + PKCE（S256），
  redirect URI `http://localhost:3000/auth/sso/callback`，
  secret `dev-only-keycloak-secret`（与 `.env.example` 一致）。
- `entitlement-web-admin` / `entitlement-user-web` 不需要单独注册客户端：
  它们只调用本 API 的 `/auth/sso/*`。

## 预置用户

| 邮箱                | 密码    | 说明                                                                     |
| ------------------- | ------- | ------------------------------------------------------------------------ |
| `buyer@example.com` | `buyer` | 普通用户，首次登录会自动建号（CUSTOMER）                                 |
| `admin@example.com` | `admin` | 登录后需本地授权管理员：`node scripts/grant-admin.mjs admin@example.com` |

`role` 不在 IdP 里映射，管理员权限始终由本 API 的 `User.role` 决定。

## 改了 realm 之后

导入只在首次启动执行，修改 JSON 后需要丢掉 Keycloak 的数据卷重新导入
（`docker compose down` 不会删命名卷，MySQL 数据不受影响）：

```bash
docker compose down
docker volume rm entitlement-api_keycloak-data
docker compose up -d
```

容器仍在运行时也可只重建 Keycloak 数据（同样不动 MySQL）。

## API 侧配置

`.env` 至少需要：

```dotenv
SSO_ISSUER="http://localhost:8080/realms/entitlement"
SSO_CLIENT_ID="entitlement-api"
SSO_CLIENT_SECRET="dev-only-keycloak-secret"
SSO_REDIRECT_URI="http://localhost:3000/auth/sso/callback"
```

`SSO_ISSUER` 必须与 discovery 里的 `issuer` 完全一致（`KC_HOSTNAME` 已固定为
`http://localhost:8080`，避免容器端口/主机名导致不一致）。

注意：Keycloak 默认 `sslRequired=external`，因此非 localhost 部署时必须走
HTTPS；生产环境请换成真实 IdP，并按 `env.schema.ts` 的要求使用 https issuer
与 client secret。

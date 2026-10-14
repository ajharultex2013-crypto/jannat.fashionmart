# Jannat Fashion Mart - Online Shop (API + Storefront + Admin) (API + Storefront + Admin)

Zero-dependency Node.js server (Node 22.5+): REST API + SQLite database + the storefront/admin website, all in one.

## Run
```
cp .env.example .env      # set JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm start                 # http://localhost:3000
```
First start creates `data.db`, seeds demo products/coupons and creates the admin user from `.env`. Open `/#/admin` and login as admin.

## REST API  (JSON, `Authorization: Bearer <token>`)
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | /api/products?q=&cat=&sort=pop\|low\|high\|rate | - | List live products |
| GET | /api/products/:id | - | Product details |
| GET | /api/settings | - | Delivery charges, phone, WhatsApp |
| POST | /api/auth/register `{name,email,pass}` | - | Sign up -> `{token,user}` |
| POST | /api/auth/login `{email,pass}` | - | Login -> `{token,user}` |
| GET | /api/auth/me | user | Current user |
| POST | /api/coupons/validate `{code,subtotal}` | - | Coupon discount |
| POST | /api/orders `{name,phone,email,div,addr,pay,trx,items:[{id,q}],coupon}` | optional | Place order (guest allowed). Prices, stock, delivery and coupon are always recalculated on the server |
| GET | /api/orders/mine | user | My orders |
| GET | /api/orders/track?id=&phone= | - | Track an order |
| GET / PATCH | /api/admin/orders, /api/admin/orders/:id `{status}` | admin | Manage orders (cancel restores stock) |
| GET / POST / PATCH / DELETE | /api/admin/products[/:id] | admin | Product CRUD (price, stock, badge, hide) |
| GET / POST / PATCH / DELETE | /api/admin/coupons[/:id] | admin | Coupon CRUD |
| PUT | /api/admin/settings | admin | Delivery charges, free-delivery rule, contact |
| GET | /api/admin/users | admin | Registered users |

## Deploy
- **VPS:** `npm start` under pm2/systemd, put Nginx + HTTPS (Let's Encrypt) in front.
- **Render/Railway/Fly:** start command `npm start`; mount a persistent disk and set `DB_FILE=/data/bazarbd.db`.
- Frontend on another domain? Set `CORS_ORIGIN` and define `window.BAZAR_API='https://api.yourdomain.com/api'` before the script in `public/index.html`.
- Back up `data.db` regularly.

## Security built in
Passwords hashed with scrypt, HS256 JWT (7 days), rate limits on login/order/track, server-side validation, parameterised SQL, security headers + CSP, admin-only routes checked on the server.

## Not included yet (needs your merchant accounts)
- Automatic **bKash/Nagad/SSLCommerz** payment: for now customers send money and enter TrxID, admin verifies it in Orders.
- **Courier APIs** (Pathao/Steadfast/RedX) and **SMS/OTP**.
- Image upload (products use emoji; add image URLs/upload when ready).

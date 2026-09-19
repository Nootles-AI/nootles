This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

`vercel.json` runs the frontend build through `convex deploy`. Configure
`CONVEX_DEPLOY_KEY` in Vercel before deploying:

- use a Convex production deploy key scoped only to **Production**;
- use a Convex preview deploy key scoped only to **Preview**.

The Convex CLI then creates or selects the right backend and injects
`NEXT_PUBLIC_CONVEX_URL` into `npm run build`. Do not copy a development URL
into every preview: preview keys keep branch data and functions isolated from
development and production.

Preview authentication also needs the Clerk development instance's
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`; its issuer must
match `CLERK_JWT_ISSUER_DOMAIN` in the preview Convex deployment.

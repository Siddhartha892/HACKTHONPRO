# Evergreen Online Banking (React)

Evergreen is a simulated online banking project. It uses React, React Router, Supabase Authentication, and Supabase Postgres so the same demo account and requests can be opened in different browsers.

## Run on Windows or macOS

1. Install [Node.js](https://nodejs.org/).
2. Unzip this folder and open it in VS Code.
3. Create `.env.local` in the project root (beside `package.json`) by copying `.env.example`. Fill in the Supabase URL and publishable key for the Evergreen Supabase project:

   ```env
   VITE_SUPABASE_URL=https://your-project-id.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
   ```

   Ask the project owner for these two public client settings. Never use or share a Supabase secret key. `.env.local` is excluded from the ZIP and GitHub repository.

4. Open a terminal in the project folder (in VS Code, choose **Terminal → New Terminal**) and run:

   ```bash
   npm install
   npm run dev
   ```

5. Open the local URL printed in the terminal, usually `http://localhost:5173`.

The Supabase database schema and Email/Password settings need to be configured once by the project owner. The SQL is in `supabase/schema.sql`. To make a production build, run `npm run build`.

## Admin sign-in

Email: `admin123@gmail.com`  
Password: `admin123`

The first admin sign-in creates the Supabase Auth user using these demo credentials. The Supabase project must have Email/Password enabled and email confirmation disabled for this first classroom sign-in.

Existing browser-only accounts can be moved online on first sign-in: open the updated app in the browser that has the old account and sign in with its existing email/password. The app creates its Supabase login and copies that account's profile and activity. Then sign in with the same credentials in the other browser. The admin should sign in once to initialize the shared admin account.

## Banking features

- User signup/login and Admin login
- User and Admin modules with protected React Router pages
- PIN-protected balance check; new accounts begin at ₹0
- Linked bank account records with masked account numbers
- Transfers with recipient QR scanning where the browser supports it
- Bill payments, transaction history, and downloadable CSV statements
- Loan requests, admin approval, and repayment installments
- Approved loans use 10% simple annual interest for the selected repayment term
- Automatic recurring payments with weekly, monthly, or quarterly schedules, pause/resume controls, and payment history
- Profile updates and customer support cases
- Admin customer search/status filters, loan approval, request filters, recurring payment pause/resume controls, transaction search, and support review

Supabase Auth manages sign-in. Account data is saved in Supabase tables with row-level security. Cloud data is loaded after sign-in, so Chrome and Safari share the same profile, balance, loan requests, and transaction history. The admin can view all account rows; users can access their own account row and a limited account directory.

Linked bank account entries keep the bank name, holder name, IFSC, and last four account digits; they are not verified or connected to external bank services. This is a classroom simulation, not a real banking service. Do not enter real banking credentials or financial information.

Recurring payments are simulated using the Evergreen account balance stored in this browser. Due payments are processed while the app is open and checked again when the app is reopened. The browser app cannot access external bank accounts or run scheduled payments while it is closed; real PhonePe-style bank mandates require bank/UPI authorization and a payment provider integration.

## Deploy on Vercel

1. Push this project folder to GitHub. Keep `.env.local` out of Git; it is ignored by `.gitignore`.
2. In Vercel, choose **Add New → Project** and import the GitHub repository.
3. Set **Root Directory** to `evergreen-online-banking` if the project folder is nested in the repository. If the project files are at the repository root, leave Root Directory unchanged.
4. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to Vercel's Environment Variables for Production (and Preview if needed).
5. Use the Vite settings: install `npm install`, build `npm run build`, output `dist`.
6. Select **Deploy**. The included `vercel.json` sends app routes back to the React entry page, so BrowserRouter routes can load directly.

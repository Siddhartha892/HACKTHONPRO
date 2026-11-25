import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { supabase } from './supabase.js';

const DB_KEY = 'evergreen_bank_v1';
const ADMIN_EMAIL = 'admin123@gmail.com';
const ADMIN_PASSWORD = 'admin123';
const INTEREST_RATE = 10;

const today = () => new Date().toISOString().slice(0, 10);
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const money = amount => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(amount) || 0);
const roundMoney = amount => Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

function startingData() {
  return {
    users: [{ id: 'admin', name: 'Bank Administrator', email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'admin', phone: '', pin: '', account: 'EVG00000001', balance: 0, status: 'Active', joined: today() }],
    transactions: [], requests: [], bills: []
  };
}

function readData() {
  try {
    const saved = JSON.parse(localStorage.getItem(DB_KEY));
    const data = saved || startingData();
    data.users ||= [];
    data.transactions ||= [];
    data.requests ||= [];
    data.bills ||= [];
    let admin = data.users.find(item => item.role === 'admin');
    if (!admin) {
      admin = startingData().users[0];
      data.users.push(admin);
    }
    admin.email = ADMIN_EMAIL;
    admin.password = ADMIN_PASSWORD;
    data.users.filter(item => item.role === 'user').forEach(item => { if (item.balance == null) item.balance = 0; item.bankAccounts ||= []; });
    return data;
  } catch {
    return startingData();
  }
}

function safeProfile(profile, id, isAdmin = false) {
  const { password, ...safe } = profile || {};
  return { ...safe, id, role: isAdmin ? 'admin' : 'user', password: '' };
}

async function writeCloudAccount(account) {
  const { error } = await supabase.from('evergreen_accounts').upsert({ user_id: account.user_id, payload: account.payload, updated_at: new Date().toISOString() });
  if (error) throw error;
  const profile = account.payload.profile;
  if (profile.role !== 'admin') {
    const { error: directoryError } = await supabase.from('account_directory').upsert({ user_id: account.user_id, display_name: profile.name, account_number: profile.account, status: profile.status, updated_at: new Date().toISOString() });
    if (directoryError) throw directoryError;
  }
}

async function loadCloudData(authUser) {
  const isAdmin = authUser.email?.toLowerCase() === ADMIN_EMAIL;
  let query = supabase.from('evergreen_accounts').select('user_id,payload');
  if (!isAdmin) query = query.eq('user_id', authUser.id);
  const [{ data: rows, error }, { data: directory, error: directoryError }] = await Promise.all([
    query,
    supabase.from('account_directory').select('user_id,display_name,account_number,status')
  ]);
  if (error) throw error;
  if (directoryError) throw directoryError;

  let ownRow = rows.find(row => row.user_id === authUser.id);
  if (!ownRow) {
    const legacy = readData();
    const legacyProfile = legacy.users.find(item => item.email?.toLowerCase() === authUser.email?.toLowerCase());
    const metadata = authUser.user_metadata || {};
    const oldId = legacyProfile?.id;
    const profile = safeProfile({
      ...(legacyProfile || {}),
      name: legacyProfile?.name || metadata.name || (isAdmin ? 'Bank Administrator' : 'Evergreen Customer'),
      email: authUser.email,
      phone: legacyProfile?.phone || metadata.phone || '',
      pin: legacyProfile?.pin || metadata.pin || '',
      account: legacyProfile?.account || (isAdmin ? 'EVG00000001' : `EVG${Date.now().toString().slice(-8)}`),
      balance: Number(legacyProfile?.balance) || 0,
      status: legacyProfile?.status || 'Active',
      joined: legacyProfile?.joined || today(),
      bankAccounts: legacyProfile?.bankAccounts || []
    }, authUser.id, isAdmin);
    ownRow = { user_id: authUser.id, payload: {
      profile,
      transactions: legacy.transactions.filter(item => item.userId === oldId).map(item => ({ ...item, userId: authUser.id })),
      requests: legacy.requests.filter(item => item.userId === oldId).map(item => ({ ...item, userId: authUser.id })),
      bills: legacy.bills.filter(item => item.userId === oldId).map(item => ({ ...item, userId: authUser.id }))
    } };
    await writeCloudAccount(ownRow);
    rows.push(ownRow);
  }

  const usersById = new Map(directory.map(item => [item.user_id, {
    id: item.user_id, name: item.display_name, email: '', account: item.account_number,
    status: item.status, role: 'user', balance: 0, pin: '', phone: '', bankAccounts: []
  }]));
  for (const row of rows) {
    const profile = safeProfile(row.payload.profile, row.user_id, isAdmin && row.payload.profile.email?.toLowerCase() === ADMIN_EMAIL);
    usersById.set(row.user_id, profile);
  }
  const accounts = rows.map(row => row.payload);
  return {
    users: [...usersById.values()],
    transactions: accounts.flatMap(account => account.transactions || []),
    requests: accounts.flatMap(account => account.requests || []),
    bills: accounts.flatMap(account => account.bills || [])
  };
}

async function saveCloudData(authUser, data) {
  const isAdmin = authUser.email?.toLowerCase() === ADMIN_EMAIL;
  const people = isAdmin
    ? data.users.filter(person => person.id === authUser.id || (person.role === 'user' && person.email))
    : data.users.filter(person => person.id === authUser.id);
  for (const person of people) {
    const profile = safeProfile({ ...person, email: person.email || authUser.email }, person.id, person.id === authUser.id && isAdmin);
    await writeCloudAccount({
      user_id: person.id,
      payload: {
        profile,
        transactions: data.transactions.filter(item => item.userId === person.id),
        requests: data.requests.filter(item => item.userId === person.id),
        bills: data.bills.filter(item => item.userId === person.id)
      }
    });
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function loanTotals(loan) {
  const principal = Number(loan.amount) || 0;
  const months = Math.max(1, Number.parseInt(loan.term, 10) || 12);
  const rate = Number(loan.interestRate ?? INTEREST_RATE);
  const interest = roundMoney(principal * rate / 100 * months / 12);
  const total = roundMoney(principal + interest);
  const repaid = Math.min(total, roundMoney(Number(loan.repaidAmount) || 0));
  return { principal, months, rate, interest, total, repaid, remaining: roundMoney(Math.max(0, total - repaid)), monthly: roundMoney(total / months) };
}

function addTransaction(data, userId, kind, title, amount, note = '') {
  data.transactions.unshift({ id: makeId(), userId, kind, title, amount: roundMoney(amount), note, date: new Date().toISOString() });
}

function nextPaymentDate(date, frequency) {
  const result = new Date(`${date}T12:00:00Z`);
  if (frequency === 'Weekly') result.setUTCDate(result.getUTCDate() + 7);
  else {
    const months = frequency === 'Quarterly' ? 3 : 1;
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
  }
  return result.toISOString().slice(0, 10);
}

function processDuePayments(data, currentDate) {
  let changed = false;
  data.requests.filter(item => item.type === 'Recurring' && item.status === 'Active').forEach(schedule => {
    schedule.nextDate ||= schedule.start;
    let runs = 0;
    while (schedule.nextDate <= currentDate && runs < 366) {
      const person = data.users.find(item => item.id === schedule.userId && item.role === 'user' && item.status === 'Active');
      schedule.lastAttempt = schedule.nextDate;
      if (person && Number(person.balance) >= Number(schedule.amount)) {
        person.balance = roundMoney(Number(person.balance) - Number(schedule.amount));
        addTransaction(data, person.id, 'debit', `Automatic payment · ${schedule.description}`, schedule.amount, `Recurring ${schedule.term} schedule`);
        schedule.lastPaymentStatus = 'Paid';
      } else {
        schedule.lastPaymentStatus = 'Failed · insufficient balance';
      }
      schedule.nextDate = nextPaymentDate(schedule.nextDate, schedule.term);
      changed = true;
      runs += 1;
    }
  });
  return changed;
}

function Panel({ title, action, children, className = '' }) {
  return <section className={`panel ${className}`}>
    {(title || action) && <div className="panel-heading">{title && <h2>{title}</h2>}{action}</div>}
    {children}
  </section>;
}

function PageHeading({ title, children, action }) {
  return <div className="page-heading"><div><h1>{title}</h1>{children && <p>{children}</p>}</div>{action}</div>;
}

function ActionButton({ children, kind = 'primary', ...props }) {
  return <button className={`button ${kind}`} {...props}>{children}</button>;
}

function Protected({ user, role, children }) {
  if (!user) return <Navigate to="/login" replace />;
  if (user.status !== 'Active') return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to={user.role === 'admin' ? '/admin' : '/dashboard'} replace />;
  return children;
}

function BankLayout({ user, onLogout, syncStatus, children }) {
  const userLinks = [
    ['/dashboard', 'Overview', '⌂'], ['/transfer', 'Transfer money', '↗'], ['/bills', 'Bill payments', '▤'],
    ['/transactions', 'Transactions', '◷'], ['/statements', 'Statements', '▧'], ['/loans', 'Loans & repayment', '⌁'],
    ['/recurring', 'Recurring payments', '⟳'], ['/check-balance', 'Check balance', '◉'], ['/support', 'Customer care', '?'], ['/linked-accounts', 'Linked bank accounts', '⌂'], ['/profile', 'My profile', '♙']
  ];
  const adminLinks = [['/admin', 'Overview', '▦'], ['/customers', 'Customers', '♙'], ['/admin/requests', 'Requests', '◷'], ['/admin/recurring', 'Auto payments', '⟳'], ['/admin/transactions', 'Transactions', '▤'], ['/admin/support', 'Support cases', '?']];
  const links = user.role === 'admin' ? adminLinks : userLinks;
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="bank-layout">
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <Link to={user.role === 'admin' ? '/admin' : '/dashboard'} className="brand"><span className="brand-mark">e</span> Evergreen</Link>
      <div className="nav-label">{user.role === 'admin' ? 'Administration' : 'Banking'}</div>
      <nav>{links.map(([path, label, icon]) => <NavLink key={path} to={path} end={path === '/dashboard' || path === '/admin'} onClick={() => setMenuOpen(false)} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><span>{icon}</span>{label}</NavLink>)}</nav>
      <button className="nav-link signout" onClick={onLogout}><span>↪</span>Sign out</button>
    </aside>
    <header className="topbar"><button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle navigation">☰</button><span>{user.role === 'admin' ? 'Admin console' : 'Personal banking'}</span><span className="sync-status">{syncStatus}</span><div className="user-chip"><span className="avatar">{user.name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase()}</span>{user.name}</div></header>
    <main className="main-content">{children}</main>
  </div>;
}

function AuthFrame({ title, subtitle, children }) {
  return <div className="auth-layout"><section className="auth-art"><Link to="/login" className="brand"><span className="brand-mark">e</span> Evergreen</Link><div><h1>Banking that grows with you.</h1><p>Manage your money with confidence. A thoughtful, clear banking experience for everyday life.</p><div className="art-card"><small>YOUR EVERYDAY ACCOUNT</small><strong>Simple. Clear. Yours.</strong><small>Transfer · Save · Plan ahead</small></div></div><small>EVERGREEN ONLINE BANKING</small></section><section className="auth-form-wrap"><div className="auth-card"><h2>{title}</h2><p className="muted">{subtitle}</p>{children}</div></section></div>;
}

function LoginPage({ onLogin, initialError = '' }) {
  const [error, setError] = useState(initialError);
  useEffect(() => setError(initialError), [initialError]);
  const navigate = useNavigate();
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const message = await onLogin(String(form.get('email')).trim().toLowerCase(), String(form.get('password')));
    if (message) setError(message);
    else navigate('/dashboard');
  }
  return <AuthFrame title="Welcome back" subtitle="Sign in to continue to your banking dashboard."><form className="form" onSubmit={submit}><Field label="Email address" name="email" type="email" autoComplete="email" required /><Field label="Password" name="password" type="password" autoComplete="current-password" required /><ActionButton type="submit">Sign in</ActionButton>{error && <p className="error-message">{error}</p>}<p className="center-links"><Link to="/forgot-password">Forgot password?</Link></p><p className="center-links">New to Evergreen? <Link to="/signup">Create an account</Link></p></form></AuthFrame>;
}

function Field({ label, name, type = 'text', ...props }) {
  return <label className="field"><span>{label}</span><input name={name} type={type} {...props} /></label>;
}

function SignupPage({ onSignup }) {
  const [error, setError] = useState('');
  const navigate = useNavigate();
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await onSignup({ name: String(form.get('name')).trim(), email: String(form.get('email')).trim().toLowerCase(), password: String(form.get('password')), phone: String(form.get('phone')).trim(), pin: String(form.get('pin')) });
    if (result.error) setError(result.error); else navigate('/dashboard');
  }
  return <AuthFrame title="Create your account" subtitle="Set up your Evergreen account."><form className="form" onSubmit={submit}><Field label="Full name" name="name" minLength="2" autoComplete="name" required /><Field label="Email address" name="email" type="email" autoComplete="email" required /><Field label="Password" name="password" type="password" minLength="6" autoComplete="new-password" required /><Field label="Phone number" name="phone" type="tel" minLength="10" required /><Field label="4-digit account PIN" name="pin" type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" required /><ActionButton type="submit">Create account</ActionButton>{error && <p className="error-message">{error}</p>}<p className="center-links">Already registered? <Link to="/login">Sign in</Link></p></form></AuthFrame>;
}

function ForgotPage() {
  const [message, setMessage] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (!supabase) { setMessage('Supabase is not configured for this site.'); return; }
    const email = String(new FormData(event.currentTarget).get('email')).trim().toLowerCase();
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
    setMessage(error ? error.message : 'If an account uses that email, Supabase will send a password reset link.');
  }
  return <AuthFrame title="Forgot password" subtitle="Enter your registered email to receive a reset link."><form className="form" onSubmit={submit}><Field label="Email address" name="email" type="email" required /><ActionButton type="submit">Send reset link</ActionButton>{message && <p className="notice">{message}</p>}<p className="center-links"><Link to="/login">Back to sign in</Link></p></form></AuthFrame>;
}

function ResetPage() {
  const [message, setMessage] = useState('');
  const navigate = useNavigate();
  async function submit(event) {
    event.preventDefault();
    if (!supabase) { setMessage('Supabase is not configured for this site.'); return; }
    const password = String(new FormData(event.currentTarget).get('password'));
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setMessage(error.message); return; }
    await supabase.auth.signOut();
    navigate('/login');
  }
  return <AuthFrame title="Reset password" subtitle="Choose a new password after opening the email link."><form className="form" onSubmit={submit}><Field label="New password" name="password" type="password" minLength="6" autoComplete="new-password" required /><ActionButton type="submit">Save new password</ActionButton>{message && <p className="error-message">{message}</p>}<p className="center-links"><Link to="/login">Back to sign in</Link></p></form></AuthFrame>;
}

function Dashboard({ user, data }) {
  const [revealed, setRevealed] = useState(false);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const transactions = data.transactions.filter(item => item.userId === user.id).slice(0, 5);
  const outflow = data.transactions.filter(item => item.userId === user.id && item.kind !== 'credit').reduce((sum, item) => sum + Number(item.amount), 0);
  function showBalance() {
    if (pin !== user.pin) { setMessage('PIN is incorrect.'); return; }
    setRevealed(true); setMessage('');
  }
  return <><PageHeading title={`Welcome, ${user.name.split(' ')[0]}`} >Your Evergreen account overview.</PageHeading><div className="stats-grid"><Stat label="ACCOUNT BALANCE">{revealed ? money(user.balance) : '••••••'}</Stat><Stat label="ACCOUNT NUMBER">{user.account}</Stat><Stat label="THIS MONTH’S OUTFLOW">{money(outflow)}</Stat><Stat label="ACCOUNT STATUS">{user.status}</Stat></div><div className="content-grid"><Panel title="Check balance with PIN"><div className="form-inline"><input aria-label="4-digit PIN" type="password" inputMode="numeric" maxLength="4" placeholder="Enter your PIN" value={pin} onChange={event => setPin(event.target.value)} /><ActionButton onClick={showBalance}>Show balance</ActionButton></div>{message && <p className="error-message">{message}</p>}</Panel><Panel title="Quick actions"><div className="quick-actions"><Link className="quick-action" to="/transfer">↗ Transfer</Link><Link className="quick-action" to="/bills">▤ Pay a bill</Link><Link className="quick-action" to="/loans">⌁ Request loan</Link><Link className="quick-action" to="/support">? Customer care</Link></div></Panel></div><Panel title="Recent activity" action={<Link to="/transactions">View all →</Link>}>{transactions.length ? <TransactionList items={transactions} /> : <Empty>No transactions yet.</Empty>}</Panel></>;
}

function Stat({ label, children }) { return <section className="stat-card"><span>{label}</span><strong>{children}</strong></section>; }
function Empty({ children }) { return <div className="empty-state">{children}</div>; }

function TransactionList({ items }) {
  return <div className="transaction-list">{items.map(item => <div className="transaction" key={item.id}><div><strong>{item.title}</strong><small>{new Date(item.date).toLocaleDateString('en-IN')}{(item.note || item.meta) ? ` · ${item.note || item.meta}` : ''}</small></div><b className={item.kind === 'credit' ? 'positive' : 'negative'}>{item.kind === 'credit' ? '+' : '−'}{money(item.amount)}</b></div>)}</div>;
}

function UserLoans({ user, data, update }) {
  const [message, setMessage] = useState('');
  const applications = data.requests.filter(item => item.userId === user.id && item.type === 'Loan');
  const approved = applications.filter(item => item.status === 'Approved');
  function requestLoan(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const loan = { id: makeId(), userId: user.id, type: 'Loan', description: String(form.get('purpose')), amount: Number(form.get('amount')), term: String(form.get('term')), status: 'Pending', interestRate: INTEREST_RATE, repaidAmount: 0, date: new Date().toISOString() };
    update(db => db.requests.unshift(loan));
    event.currentTarget.reset();
    setMessage('Loan request sent for admin review.');
  }
  function repay(loanId, amount) {
    const loan = data.requests.find(item => item.id === loanId && item.userId === user.id && item.status === 'Approved');
    if (!loan) return;
    const totals = loanTotals(loan), payment = roundMoney(Number(amount));
    if (!Number.isFinite(payment) || payment <= 0 || payment > totals.remaining) { setMessage('Enter an amount within the remaining loan balance.'); return; }
    if (payment > Number(user.balance)) { setMessage('Your account balance is not enough for this repayment.'); return; }
    update(db => {
      const target = db.requests.find(item => item.id === loanId);
      const borrower = db.users.find(item => item.id === user.id);
      borrower.balance = roundMoney(borrower.balance - payment);
      target.repaidAmount = roundMoney((Number(target.repaidAmount) || 0) + payment);
      addTransaction(db, user.id, 'debit', 'Loan repayment', payment, `Loan ${loanId}`);
    });
    setMessage('Repayment recorded.');
  }
  return <><PageHeading title="Loans and repayment">Request a loan, review its status, and repay approved loans with interest.</PageHeading><div className="content-grid"><Panel title="Request a loan"><p className="muted">Approved loans are credited to your account. The annual simple interest rate is 10%.</p><form className="form" onSubmit={requestLoan}><Field label="Loan purpose" name="purpose" required /><Field label="Amount (₹)" name="amount" type="number" min="1000" max="5000000" required /><label className="field"><span>Repayment period</span><select name="term"><option>12 months</option><option>24 months</option><option>36 months</option><option>60 months</option></select></label><ActionButton type="submit">Submit request</ActionButton>{message && <p className="notice">{message}</p>}</form></Panel><Panel title="Your applications">{applications.length ? applications.map(item => <div className="loan-row" key={item.id}><div><strong>{item.description} · {money(item.amount)}</strong><small>{item.term} · Requested {new Date(item.date).toLocaleDateString('en-IN')}</small></div><span className={`badge ${item.status.toLowerCase()}`}>{item.status}</span></div>) : <Empty>No loan requests yet.</Empty>}</Panel></div><Panel title="Repayment schedule"><p className="muted">Simple interest is calculated at 10% per year for the selected term. Payments are taken from your Evergreen balance.</p>{approved.length ? approved.map(loan => <RepaymentCard key={loan.id} loan={loan} onRepay={repay} />) : <Empty>Approved loans will appear here.</Empty>}{message && <p className="notice">{message}</p>}</Panel></>;
}

function RepaymentCard({ loan, onRepay }) {
  const totals = loanTotals(loan);
  const [amount, setAmount] = useState(Math.min(totals.monthly, totals.remaining).toFixed(2));
  useEffect(() => setAmount(Math.min(totals.monthly, totals.remaining).toFixed(2)), [totals.monthly, totals.remaining]);
  return <div className="repayment-card"><div className="loan-row"><div><strong>{loan.description}</strong><small>Principal {money(totals.principal)} · Interest {money(totals.interest)} at {totals.rate}% p.a. · Term {loan.term}</small></div><span className="badge">{totals.remaining === 0 ? 'Paid off' : 'Active'}</span></div><p>Total due: <b>{money(totals.total)}</b> · Repaid: {money(totals.repaid)} · Remaining: <b>{money(totals.remaining)}</b></p>{totals.remaining > 0 && <div className="form-inline"><label className="field"><span>Suggested monthly payment: {money(totals.monthly)}</span><input type="number" min="0.01" max={totals.remaining} step="0.01" value={amount} onChange={event => setAmount(event.target.value)} /></label><ActionButton onClick={() => onRepay(loan.id, amount)}>Make repayment</ActionButton></div>}</div>;
}

function TransferPage({ user, data, transferFunds }) {
  const [message, setMessage] = useState('');
  const [scanning, setScanning] = useState(false);
  const [account, setAccount] = useState('');
  const video = useRef(null);
  useEffect(() => () => video.current?.srcObject?.getTracks().forEach(track => track.stop()), []);
  async function scanQr() {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) { setMessage('QR scanning is not available in this browser. Enter the recipient account number instead.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.current.srcObject = stream; await video.current.play(); setScanning(true);
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const scan = async () => {
        if (!video.current || !video.current.isConnected) { stream.getTracks().forEach(track => track.stop()); return; }
        const codes = await detector.detect(video.current).catch(() => []);
        if (codes.length) {
          const found = codes[0].rawValue.match(/EVG[A-Z0-9]+/i)?.[0];
          if (found) { setAccount(found); setScanning(false); stream.getTracks().forEach(track => track.stop()); setMessage('Recipient account scanned.'); return; }
        }
        if (video.current && !video.current.hidden) requestAnimationFrame(scan);
      };
      requestAnimationFrame(scan);
    } catch { setMessage('Camera access was unavailable. Enter the account number manually.'); }
  }
  async function submit(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement), recipient = data.users.find(item => item.role === 'user' && item.account === String(form.get('account')).trim() && item.status === 'Active'), amount = Number(form.get('amount'));
    if (!recipient || recipient.id === user.id) { setMessage('Choose a different, active Evergreen customer account.'); return; }
    if (!Number.isFinite(amount) || amount <= 0 || amount > Number(user.balance)) { setMessage('Check the amount and available balance.'); return; }
    try { await transferFunds(user.id, recipient.id, amount, String(form.get('note') || 'Evergreen transfer')); setMessage('Transfer completed.'); formElement.reset(); setAccount(''); }
    catch (error) { setMessage(error.message || 'Transfer could not be completed.'); }
  }
  return <><PageHeading title="Transfer money">Send money to another Evergreen account.</PageHeading><Panel className="form-panel"><p className="notice">The recipient must have an active Evergreen account.</p><form className="form" onSubmit={submit}><div className="field"><span>Recipient account number</span><div className="form-inline"><input name="account" value={account} onChange={event => setAccount(event.target.value)} placeholder="EVG12345678" required /><ActionButton type="button" kind="secondary" onClick={scanQr}>Scan QR</ActionButton></div></div><video className="qr-video" ref={video} style={{ display: scanning ? 'block' : 'none' }} playsInline /><Field label="Amount (₹)" name="amount" type="number" min="0.01" step="0.01" required /><Field label="Note (optional)" name="note" maxLength="80" /><ActionButton type="submit">Review and transfer</ActionButton>{message && <p className="notice">{message}</p>}</form></Panel></>;
}

function BillsPage({ user, data, update }) {
  const [message, setMessage] = useState('');
  const bills = data.bills.filter(item => item.userId === user.id);
  function submit(event) {
    event.preventDefault(); const f = new FormData(event.currentTarget), amount = Number(f.get('amount'));
    if (amount <= 0 || amount > Number(user.balance)) { setMessage('Check the amount and available balance.'); return; }
    const bill = { id: makeId(), userId: user.id, category: String(f.get('category')), provider: String(f.get('provider')), reference: String(f.get('reference')), amount: roundMoney(amount), date: new Date().toISOString() };
    update(db => { const payer = db.users.find(item => item.id === user.id); payer.balance = roundMoney(payer.balance - amount); db.bills.unshift(bill); addTransaction(db, user.id, 'debit', `${bill.category} bill · ${bill.provider}`, amount, bill.reference); });
    setMessage('Bill payment recorded.'); event.currentTarget.reset();
  }
  return <><PageHeading title="Bill payments">Pay and review utility bills.</PageHeading><div className="content-grid"><Panel title="Pay a bill"><form className="form" onSubmit={submit}><label className="field"><span>Biller category</span><select name="category"><option>Electricity</option><option>Water</option><option>Internet</option><option>Mobile</option><option>Gas</option></select></label><Field label="Provider" name="provider" required /><Field label="Consumer / reference number" name="reference" required /><Field label="Amount (₹)" name="amount" type="number" min="0.01" step="0.01" required /><ActionButton type="submit">Pay bill</ActionButton>{message && <p className="notice">{message}</p>}</form></Panel><Panel title="Recent bill payments">{bills.length ? bills.map(item => <div className="loan-row" key={item.id}><div><strong>{item.category} · {item.provider}</strong><small>{item.reference} · {new Date(item.date).toLocaleDateString('en-IN')}</small></div><b>{money(item.amount)}</b></div>) : <Empty>No bills paid yet.</Empty>}</Panel></div></>;
}

function TransactionsPage({ user, data }) {
  const [query, setQuery] = useState('');
  const rows = data.transactions.filter(item => item.userId === user.id && `${item.title} ${item.note || item.meta || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeading title="Transactions">Search recent account activity.</PageHeading><Panel><Field label="Search transactions" name="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by description" />{rows.length ? <TransactionList items={rows} /> : <Empty>No matching transactions.</Empty>}</Panel></>;
}

function StatementsPage({ user, data }) {
  const items = data.transactions.filter(item => item.userId === user.id);
  function download() {
    const rows = [['Date', 'Description', 'Type', 'Amount'], ...items.map(item => [new Date(item.date).toLocaleDateString('en-IN'), item.title, item.kind, item.amount])];
    const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'evergreen-statement.csv'; link.click(); URL.revokeObjectURL(link.href);
  }
  return <><PageHeading title="Statements" action={<ActionButton onClick={download}>Download CSV</ActionButton>}>Your account activity statement.</PageHeading><Panel title="Account statement">{items.length ? <TransactionList items={items} /> : <Empty>No transaction records to include yet.</Empty>}</Panel></>;
}

function CheckBalancePage({ user }) {
  const [pin, setPin] = useState(''); const [shown, setShown] = useState(false); const [message, setMessage] = useState('');
  function check(event) { event.preventDefault(); if (pin !== user.pin) { setShown(false); setMessage('PIN is incorrect.'); } else { setShown(true); setMessage(''); } }
  return <><PageHeading title="Check balance">Your balance stays hidden until you enter your PIN.</PageHeading><Panel className="narrow-panel"><form className="form" onSubmit={check}><Field label="4-digit account PIN" name="pin" type="password" inputMode="numeric" maxLength="4" value={pin} onChange={event => setPin(event.target.value)} required /><ActionButton type="submit">Show balance</ActionButton></form>{message && <p className="error-message">{message}</p>}{shown && <p className="balance-result">Available balance: <b>{money(user.balance)}</b></p>}</Panel></>;
}

function ProfilePage({ user, update }) {
  const [message, setMessage] = useState('');
  function submit(event) { event.preventDefault(); const form = new FormData(event.currentTarget), name = String(form.get('name')).trim(), phone = String(form.get('phone')).trim(); update(db => { const person = db.users.find(item => item.id === user.id); person.name = name; person.phone = phone; }); setMessage('Profile updated.'); }
  return <><PageHeading title="My profile">Manage your account information.</PageHeading><Panel className="narrow-panel"><form className="form" onSubmit={submit}><Field label="Full name" name="name" defaultValue={user.name} required minLength="2" /><Field label="Email address" name="email" type="email" defaultValue={user.email} disabled /><Field label="Phone number" name="phone" defaultValue={user.phone} required minLength="10" /><Field label="Account number" name="account" defaultValue={user.account} disabled /><ActionButton type="submit">Save profile</ActionButton>{message && <p className="notice">{message}</p>}</form></Panel></>;
}

function LinkedAccountsPage({ user, update }) {
  const [message, setMessage] = useState('');
  const accounts = user.bankAccounts || [];
  function addAccount(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const bank = String(form.get('bank'));
    const holder = String(form.get('holder')).trim();
    const ifsc = String(form.get('ifsc')).trim().toUpperCase();
    const accountNumber = String(form.get('accountNumber')).replace(/\s/g, '');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) { setMessage('Enter a valid 11-character IFSC code.'); return; }
    const last4 = accountNumber.slice(-4);
    if (accounts.some(item => item.bank === bank && item.last4 === last4)) { setMessage('This account is already listed.'); return; }
    update(db => {
      const customer = db.users.find(item => item.id === user.id);
      customer.bankAccounts ||= [];
      customer.bankAccounts.push({ id: makeId(), bank, holder, ifsc, last4, addedAt: new Date().toISOString() });
    });
    setMessage('Bank account added to your Evergreen profile.');
    event.currentTarget.reset();
  }
  function removeAccount(id) { update(db => { const customer = db.users.find(item => item.id === user.id); customer.bankAccounts = (customer.bankAccounts || []).filter(item => item.id !== id); }); }
  return <><PageHeading title="Linked bank accounts">Keep a list of bank accounts in your Evergreen profile.</PageHeading><div className="content-grid"><Panel title="Add a bank account"><p className="notice">This page stores a masked account record in your browser. It does not verify bank ownership or access external bank services. Never enter your online banking password, ATM PIN, CVV, or OTP.</p><form className="form" onSubmit={addAccount}><label className="field"><span>Bank</span><select name="bank" required><option value="">Choose your bank</option><option>State Bank of India</option><option>HDFC Bank</option><option>ICICI Bank</option><option>Axis Bank</option><option>Other bank</option></select></label><Field label="Account holder name" name="holder" defaultValue={user.name} required /><Field label="Account number" name="accountNumber" inputMode="numeric" minLength="9" maxLength="18" pattern="[0-9]{9,18}" autoComplete="off" required /><Field label="IFSC code" name="ifsc" minLength="11" maxLength="11" pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" autoCapitalize="characters" required /><ActionButton type="submit">Add account</ActionButton>{message && <p className="notice">{message}</p>}</form></Panel><Panel title="Your linked accounts">{accounts.length ? accounts.map(account => <div className="loan-row" key={account.id}><div><strong>{account.bank} · •••• {account.last4}</strong><small>{account.holder} · {account.ifsc}</small></div><ActionButton kind="secondary" onClick={() => removeAccount(account.id)}>Remove</ActionButton></div>) : <Empty>No bank accounts added yet.</Empty>}</Panel></div></>;
}

function RecurringPage({ user, data, update }) {
  const [message, setMessage] = useState('');
  const entries = data.requests.filter(item => item.userId === user.id && item.type === 'Recurring');
  function submit(event) { event.preventDefault(); const f = new FormData(event.currentTarget); const start = String(f.get('start')); const entry = { id: makeId(), userId: user.id, type: 'Recurring', description: String(f.get('description')), amount: Number(f.get('amount')), term: String(f.get('frequency')), start, nextDate: start, status: 'Active', date: new Date().toISOString() }; update(db => db.requests.unshift(entry)); setMessage('Automatic payment schedule created. Payments will be deducted from your Evergreen balance on the due date.'); event.currentTarget.reset(); }
  function pause(item) { update(db => { const schedule = db.requests.find(row => row.id === item.id); if (schedule) schedule.status = schedule.status === 'Paused' ? 'Active' : 'Paused'; }); }
  return <><PageHeading title="Recurring payments">Set up automatic payments from your Evergreen balance.</PageHeading><div className="content-grid"><Panel title="New automatic payment"><p className="notice">On each due date, the scheduled amount is deducted from your Evergreen balance and added to transaction history. Keep enough balance for the payment.</p><form className="form" onSubmit={submit}><Field label="Payment description" name="description" placeholder="For example, monthly internet bill" required /><Field label="Amount (₹)" name="amount" type="number" min="0.01" step="0.01" required /><label className="field"><span>Frequency</span><select name="frequency"><option>Weekly</option><option>Monthly</option><option>Quarterly</option></select></label><Field label="First payment date" name="start" type="date" min={today()} defaultValue={today()} required /><ActionButton type="submit">Create auto payment</ActionButton>{message && <p className="notice">{message}</p>}</form></Panel><Panel title="Your automatic payments">{entries.length ? entries.map(item => <div className="loan-row" key={item.id}><div><strong>{item.description} · {money(item.amount)}</strong><small>{item.term} · Next payment: {new Date(`${item.nextDate || item.start}T12:00:00`).toLocaleDateString('en-IN')} · {item.lastPaymentStatus ? `Last: ${item.lastPaymentStatus}` : 'No payments yet'}</small></div><div className="schedule-actions"><span className={`badge ${item.status.toLowerCase()}`}>{item.status}</span><ActionButton kind="secondary" onClick={() => pause(item)}>{item.status === 'Paused' ? 'Resume' : 'Pause'}</ActionButton></div></div>) : <Empty>No automatic payments set up.</Empty>}</Panel></div></>;
}

function SupportPage({ user, data, update }) {
  const [message, setMessage] = useState('');
  const cases = data.requests.filter(item => item.userId === user.id && item.type === 'Support');
  const transfers = data.transactions.filter(item => item.userId === user.id && (item.kind === 'transfer' || item.title.toLowerCase().startsWith('transfer to')));
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const transfer = transfers.find(item => item.id === form.get('transaction'));
    const category = String(form.get('category'));
    const details = String(form.get('details')).trim();
    const ticket = { id: makeId(), userId: user.id, type: 'Support', subject: category, details, description: `${category}: ${details}`, reference: transfer?.id || '', amount: transfer?.amount || 0, status: 'Open', date: new Date().toISOString() };
    update(db => db.requests.unshift(ticket));
    setMessage('Support request submitted. Customer care will review it.');
    event.currentTarget.reset();
  }
  return <><PageHeading title="Customer care">Send a support request and check its status.</PageHeading><div className="content-grid"><Panel title="Contact support"><p className="notice">For an accidental transfer, select the transfer so customer care can identify it. The request is reviewed by the administrator.</p><form className="form" onSubmit={submit}><label className="field"><span>What do you need help with?</span><select name="category"><option>Accidental transfer</option><option>Bill payment issue</option><option>Loan request</option><option>Account access</option><option>Other</option></select></label><label className="field"><span>Related transfer (optional)</span><select name="transaction"><option value="">Select a transfer</option>{transfers.map(item => <option value={item.id} key={item.id}>{item.id} · {item.title} · {money(item.amount)}</option>)}</select></label><label className="field"><span>Details</span><textarea name="details" rows="4" maxLength="500" required /></label><ActionButton type="submit">Submit request</ActionButton>{message && <p className="notice">{message}</p>}</form></Panel><Panel title="Your support requests">{cases.length ? cases.map(ticket => <div className="loan-row" key={ticket.id}><div><strong>{ticket.subject || ticket.description}</strong><small>{ticket.details || ticket.description} · Case {ticket.id}{ticket.reference ? ` · Transfer ${ticket.reference}` : ''} · {new Date(ticket.date).toLocaleDateString('en-IN')}</small></div><span className="badge">{ticket.status}</span></div>) : <Empty>No support requests yet.</Empty>}</Panel></div><Panel title="Frequently asked questions"><details><summary>How do I check my balance?</summary><p>Open Check balance and enter the 4-digit PIN you created.</p></details><details><summary>How are loan repayments calculated?</summary><p>Approved loans use 10% simple annual interest for the chosen term.</p></details></Panel></>;
}

function AdminDashboard({ data }) {
  const customers = data.users.filter(item => item.role === 'user');
  const pending = data.requests.filter(item => item.type === 'Loan' && item.status === 'Pending').length;
  const activeSchedules = data.requests.filter(item => item.type === 'Recurring' && item.status === 'Active').length;
  return <><PageHeading title="Admin overview">Manage customer accounts, loan requests, recurring payments, and customer support.</PageHeading><div className="stats-grid"><Stat label="CUSTOMERS">{customers.length}</Stat><Stat label="PENDING LOANS">{pending}</Stat><Stat label="SUPPORT CASES">{data.requests.filter(item => item.type === 'Support' && item.status === 'Open').length}</Stat><Stat label="ACTIVE AUTO PAYMENTS">{activeSchedules}</Stat></div><div className="content-grid"><Panel title="Latest customers" action={<Link to="/customers">View all →</Link>}>{customers.slice(-5).reverse().map(customer => <div className="loan-row" key={customer.id}><div><strong>{customer.name}</strong><small>{customer.email} · {customer.account}</small></div><span className="badge">{customer.status}</span></div>)}</Panel><Panel title="Requests to review" action={<Link to="/admin/requests">Review requests →</Link>}>{pending ? data.requests.filter(item => item.type === 'Loan' && item.status === 'Pending').slice(0, 5).map(item => <div className="loan-row" key={item.id}><div><strong>{data.users.find(u => u.id === item.userId)?.name || 'Customer'} · {money(item.amount)}</strong><small>{item.description} · {item.term}</small></div><span className="badge pending">Pending</span></div>) : <Empty>No pending loans.</Empty>}</Panel></div><Panel title="Recurring payment oversight" action={<Link to="/admin/recurring">Manage schedules →</Link>}><p className="muted">Review customer auto-payment schedules and pause or resume them when needed.</p></Panel></>;
}

function CustomersPage({ data, update }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const customers = data.users.filter(item => item.role === 'user' && (statusFilter === 'All' || item.status === statusFilter) && `${item.name} ${item.email} ${item.account}`.toLowerCase().includes(search.toLowerCase()));
  function toggle(id) { update(db => { const target = db.users.find(item => item.id === id); target.status = target.status === 'Active' ? 'Suspended' : 'Active'; }); }
  return <><PageHeading title="Customers">Search accounts, filter by status, and suspend or reactivate access.</PageHeading><Panel title="Registered customers"><div className="admin-filters"><Field label="Find customer" name="customerSearch" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, email, or account number" /><label className="field"><span>Account status</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option>All</option><option>Active</option><option>Suspended</option></select></label></div>{customers.length ? <div className="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Account</th><th>Balance</th><th>Status</th><th>Action</th></tr></thead><tbody>{customers.map(item => <tr key={item.id}><td><Link to={`/customers/${item.id}`}>{item.name}</Link></td><td>{item.email}</td><td>{item.account}</td><td>{money(item.balance)}</td><td>{item.status}</td><td><ActionButton kind="secondary" onClick={() => toggle(item.id)}>{item.status === 'Active' ? 'Suspend' : 'Activate'}</ActionButton></td></tr>)}</tbody></table></div> : <Empty>No customers match these filters.</Empty>}</Panel></>;
}

function CustomerDetails({ data }) {
  const { customerId } = useParams();
  const customer = data.users.find(item => item.id === customerId && item.role === 'user');
  if (!customer) return <><PageHeading title="Customer not found" /><Link to="/customers">Back to customers</Link></>;
  const transactions = data.transactions.filter(item => item.userId === customer.id).slice(0, 8);
  return <><PageHeading title={customer.name} >Customer account details.</PageHeading><div className="stats-grid"><Stat label="EMAIL">{customer.email}</Stat><Stat label="ACCOUNT NUMBER">{customer.account}</Stat><Stat label="BALANCE">{money(customer.balance)}</Stat><Stat label="STATUS">{customer.status}</Stat></div><Panel title="Recent transactions">{transactions.length ? <TransactionList items={transactions} /> : <Empty>No transactions yet.</Empty>}</Panel><p><Link to="/customers">← Back to customers</Link></p></>;
}

function AdminRequests({ data, update }) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const rows = data.requests.filter(item => {
    const customer = data.users.find(user => user.id === item.userId);
    return (typeFilter === 'All' || item.type === typeFilter) && (statusFilter === 'All' || item.status === statusFilter) && `${customer?.name || ''} ${customer?.email || ''} ${item.description || ''} ${item.subject || ''}`.toLowerCase().includes(search.toLowerCase());
  });
  function decide(id, status) {
    update(db => {
      const request = db.requests.find(item => item.id === id);
      if (!request || request.status !== 'Pending') return;
      request.status = status;
      if (status === 'Approved' && request.type === 'Loan') {
        request.interestRate = INTEREST_RATE; request.repaidAmount = 0;
        const borrower = db.users.find(item => item.id === request.userId);
        if (borrower) { borrower.balance = roundMoney(borrower.balance + Number(request.amount)); addTransaction(db, borrower.id, 'credit', 'Loan disbursement', request.amount, `Request ${request.id}`); }
      }
    });
  }
  return <><PageHeading title="Requests">Search and filter loan, support, and recurring payment requests.</PageHeading><Panel title="All requests"><div className="admin-filters"><Field label="Search requests" name="requestSearch" value={search} onChange={event => setSearch(event.target.value)} placeholder="Customer or request details" /><label className="field"><span>Type</span><select value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option>All</option><option>Loan</option><option>Support</option><option>Recurring</option></select></label><label className="field"><span>Status</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option>All</option><option>Pending</option><option>Approved</option><option>Declined</option><option>Open</option><option>Closed</option><option>Active</option><option>Paused</option></select></label></div>{rows.length ? <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Type</th><th>Details</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>{rows.map(item => <tr key={item.id}><td>{data.users.find(user => user.id === item.userId)?.name || 'Customer'}</td><td>{item.type}</td><td>{item.description || item.subject || '—'}</td><td>{item.amount ? money(item.amount) : '—'}</td><td>{item.status}</td><td>{item.type === 'Loan' && item.status === 'Pending' ? <><ActionButton onClick={() => decide(item.id, 'Approved')}>Approve</ActionButton> <ActionButton kind="secondary" onClick={() => decide(item.id, 'Declined')}>Decline</ActionButton></> : item.status}</td></tr>)}</tbody></table></div> : <Empty>No requests match these filters.</Empty>}</Panel></>;
}

function AdminRecurring({ data, update }) {
  const schedules = data.requests.filter(item => item.type === 'Recurring');
  function toggle(id) { update(db => { const schedule = db.requests.find(item => item.id === id && item.type === 'Recurring'); if (schedule) schedule.status = schedule.status === 'Paused' ? 'Active' : 'Paused'; }); }
  return <><PageHeading title="Automatic payments">Review and control customer recurring payment schedules.</PageHeading><Panel title="Customer schedules">{schedules.length ? <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Payment</th><th>Frequency</th><th>Next due</th><th>Last result</th><th>Status</th><th>Action</th></tr></thead><tbody>{schedules.map(item => { const customer = data.users.find(user => user.id === item.userId); return <tr key={item.id}><td>{customer?.name || 'Customer'}<br /><small>{customer?.account || ''}</small></td><td>{item.description}<br /><b>{money(item.amount)}</b></td><td>{item.term}</td><td>{new Date(`${item.nextDate || item.start}T12:00:00`).toLocaleDateString('en-IN')}</td><td>{item.lastPaymentStatus || 'No payment yet'}</td><td><span className={`badge ${(item.status || 'Active').toLowerCase()}`}>{item.status || 'Active'}</span></td><td><ActionButton kind="secondary" onClick={() => toggle(item.id)}>{item.status === 'Paused' ? 'Resume' : 'Pause'}</ActionButton></td></tr>; })}</tbody></table></div> : <Empty>No recurring payment schedules have been created.</Empty>}</Panel></>;
}

function AdminTransactions({ data }) {
  const [search, setSearch] = useState('');
  const rows = data.transactions.filter(item => { const person = data.users.find(user => user.id === item.userId); return `${item.title} ${item.note || item.meta || ''} ${person?.name} ${person?.account}`.toLowerCase().includes(search.toLowerCase()); });
  return <><PageHeading title="All transactions">Search activity across customer accounts.</PageHeading><Panel><Field label="Search" name="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Customer, account, or transaction" />{rows.length ? <TransactionList items={rows.map(item => ({ ...item, title: `${data.users.find(u => u.id === item.userId)?.name || 'Customer'} · ${item.title}` }))} /> : <Empty>No transactions found.</Empty>}</Panel></>;
}

function AdminSupport({ data, update }) {
  function closeCase(id) { update(db => { const ticket = db.requests.find(item => item.id === id && item.type === 'Support'); if (ticket) ticket.status = 'Closed'; }); }
  return <><PageHeading title="Support cases">Review customer care requests.</PageHeading><Panel title="Customer requests">{data.requests.filter(ticket => ticket.type === 'Support').length ? data.requests.filter(ticket => ticket.type === 'Support').map(ticket => <div className="support-ticket" key={ticket.id}><div><strong>{data.users.find(user => user.id === ticket.userId)?.name || 'Customer'} · {ticket.subject || ticket.description}</strong><p>{ticket.details || ticket.description}</p><small>{new Date(ticket.date).toLocaleDateString('en-IN')}{ticket.reference ? ` · Related transaction ${ticket.reference}` : ''}</small></div><div><span className="badge">{ticket.status}</span> {ticket.status === 'Open' && <ActionButton kind="secondary" onClick={() => closeCase(ticket.id)}>Close case</ActionButton>}</div></div>) : <Empty>No support cases yet.</Empty>}</Panel></>;
}

function NotFound() { return <div className="not-found"><span className="brand-mark">e</span><h1>Page not found</h1><p>The page you requested doesn’t exist.</p><Link to="/login">Return to Evergreen</Link></div>; }

export default function App() {
  const [data, setData] = useState(readData);
  const [userId, setUserId] = useState(null);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [cloudReady, setCloudReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [startupError, setStartupError] = useState('');
  const [syncError, setSyncError] = useState('');
  const navigate = useNavigate();
  const user = useMemo(() => data.users.find(item => item.id === userId) || null, [data.users, userId]);
  useEffect(() => {
    let mounted = true;
    async function restoreSession() {
      if (!supabase) { setStartupError('Supabase settings are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.'); setAuthLoading(false); return; }
      const { data: sessionResult, error } = await supabase.auth.getSession();
      if (error) setStartupError(error.message);
      if (sessionResult?.session?.user) {
        try {
          const cloudData = await loadCloudData(sessionResult.session.user);
          if (mounted) { setData(cloudData); setAuthUser(sessionResult.session.user); setUserId(sessionResult.session.user.id); setCloudReady(true); }
        } catch (loadError) { if (mounted) setStartupError(`Could not load shared account data: ${loadError.message}. Check that Supabase setup SQL has been run.`); }
      }
      if (mounted) setAuthLoading(false);
    }
    restoreSession().catch(error => { if (mounted) { setStartupError(error.message); setAuthLoading(false); } });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (!supabase) return undefined;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') { setCloudReady(false); setAuthUser(null); setUserId(null); }
    });
    return () => subscription.unsubscribe();
  }, []);
  const saveQueue = useRef(Promise.resolve());
  useEffect(() => {
    if (!cloudReady || !authUser) return;
    let cancelled = false;
    setSyncStatus('Saving online…');
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => saveCloudData(authUser, data));
    saveQueue.current.then(() => { if (!cancelled) { setSyncError(''); setSyncStatus('Saved online'); } }).catch(error => { if (!cancelled) { setSyncError(`Cloud save failed: ${error.message}`); setSyncStatus('Save failed'); } });
    return () => { cancelled = true; };
  }, [data, authUser, cloudReady]);
  useEffect(() => {
    const run = () => setData(current => { const next = clone(current); return processDuePayments(next, today()) ? next : current; });
    run();
    const timer = window.setInterval(run, 60_000);
    window.addEventListener('focus', run);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', run); };
  }, []);
  function update(change) { setData(current => { const next = clone(current); change(next); return next; }); }
  async function activateAccount(authenticatedUser) {
    const cloudData = await loadCloudData(authenticatedUser);
    setData(cloudData); setAuthUser(authenticatedUser); setUserId(authenticatedUser.id); setCloudReady(true); setStartupError('');
  }
  async function login(email, password) {
    if (!supabase) return 'Supabase settings are missing. Add the VITE_SUPABASE values and restart Vite.';
    let result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error) {
      const legacy = readData().users.find(item => item.email?.toLowerCase() === email && item.password === password);
      if (!legacy) return result.error.message;
      const created = await supabase.auth.signUp({ email, password, options: { data: { name: legacy.name, phone: legacy.phone || '', pin: legacy.pin || '' } } });
      if (created.error) return created.error.message;
      if (!created.data.session) return 'Check your email to confirm the account, then sign in again. For this classroom demo you can disable email confirmation in Supabase Authentication settings.';
      result = { data: created.data, error: null };
    }
    try { await activateAccount(result.data.user); return ''; }
    catch (error) { await supabase.auth.signOut(); return `Could not load shared account data: ${error.message}. Run the Supabase setup SQL first.`; }
  }
  async function signup(details) {
    if (!supabase) return { error: 'Supabase settings are missing. Add the VITE_SUPABASE values and restart Vite.' };
    if (details.email === ADMIN_EMAIL) return { error: 'The administrator account is reserved. Sign in with the admin credentials instead.' };
    if (data.users.some(item => item.email === details.email)) return { error: 'An account with this email already exists. Sign in to move it online.' };
    if (details.phone.replace(/\D/g, '').length < 10) return { error: 'Enter a valid 10-digit phone number.' };
    const { data: result, error } = await supabase.auth.signUp({ email: details.email, password: details.password, options: { data: { name: details.name, phone: details.phone, pin: details.pin } } });
    if (error) return { error: error.message };
    if (!result.session) return { error: 'Check your email to confirm your account, then sign in. For this classroom demo, email confirmation can be turned off in Supabase Authentication settings.' };
    try { await activateAccount(result.user); return { error: '' }; }
    catch (loadError) { await supabase.auth.signOut(); return { error: `Could not load shared account data: ${loadError.message}. Run the Supabase setup SQL first.` }; }
  }
  async function logout() { await supabase?.auth.signOut(); setCloudReady(false); setAuthUser(null); setUserId(null); navigate('/login'); }
  async function transferFunds(senderId, recipientId, amount, note) {
    const { error } = await supabase.rpc('evergreen_transfer', { p_sender_id: senderId, p_recipient_id: recipientId, p_amount: amount, p_note: note });
    if (error) throw error;
    const refreshed = await loadCloudData(authUser);
    setData(refreshed);
  }
  const requireUser = element => <Protected user={user} role="user"><BankLayout user={user} onLogout={logout} syncStatus={syncStatus}>{element}</BankLayout></Protected>;
  const requireAdmin = element => <Protected user={user} role="admin"><BankLayout user={user} onLogout={logout} syncStatus={syncStatus}>{element}</BankLayout></Protected>;
  if (authLoading) return <div className="not-found"><p>Connecting to Evergreen shared banking data…</p></div>;
  return <>{syncError && <div className="cloud-warning">{syncError} Changes may not be shared between browsers yet.</div>}<Routes>
    <Route path="/" element={<Navigate to={user ? user.role === 'admin' ? '/admin' : '/dashboard' : '/login'} replace />} />
    <Route path="/login" element={user?.status === 'Active' ? <Navigate to={user.role === 'admin' ? '/admin' : '/dashboard'} replace /> : <LoginPage onLogin={login} initialError={startupError} />} />
    <Route path="/signup" element={user?.status === 'Active' ? <Navigate to={user.role === 'admin' ? '/admin' : '/dashboard'} replace /> : <SignupPage onSignup={signup} />} />
    <Route path="/forgot-password" element={<ForgotPage />} />
    <Route path="/reset-password" element={<ResetPage />} />
    <Route path="/dashboard" element={requireUser(<Dashboard user={user || { name: '', id: '', balance: 0 }} data={data} />)} />
    <Route path="/transfer" element={requireUser(<TransferPage user={user || { id: '', balance: 0 }} data={data} transferFunds={transferFunds} />)} />
    <Route path="/bills" element={requireUser(<BillsPage user={user || { id: '', balance: 0 }} data={data} update={update} />)} />
    <Route path="/transactions" element={requireUser(<TransactionsPage user={user || { id: '' }} data={data} />)} />
    <Route path="/statements" element={requireUser(<StatementsPage user={user || { id: '' }} data={data} />)} />
    <Route path="/loans" element={requireUser(<UserLoans user={user || { id: '', balance: 0 }} data={data} update={update} />)} />
    <Route path="/recurring" element={requireUser(<RecurringPage user={user || { id: '' }} data={data} update={update} />)} />
    <Route path="/profile" element={requireUser(<ProfilePage user={user || { id: '', name: '', email: '', account: '', phone: '' }} update={update} />)} />
    <Route path="/linked-accounts" element={requireUser(<LinkedAccountsPage user={user || { id: '', name: '', bankAccounts: [] }} update={update} />)} />
    <Route path="/check-balance" element={requireUser(<CheckBalancePage user={user || { pin: '', balance: 0 }} />)} />
    <Route path="/support" element={requireUser(<SupportPage user={user || { id: '' }} data={data} update={update} />)} />
    <Route path="/admin" element={requireAdmin(<AdminDashboard data={data} />)} />
    <Route path="/customers" element={requireAdmin(<CustomersPage data={data} update={update} />)} />
    <Route path="/customers/:customerId" element={requireAdmin(<CustomerDetails data={data} />)} />
    <Route path="/admin/requests" element={requireAdmin(<AdminRequests data={data} update={update} />)} />
    <Route path="/admin/recurring" element={requireAdmin(<AdminRecurring data={data} update={update} />)} />
    <Route path="/admin/transactions" element={requireAdmin(<AdminTransactions data={data} />)} />
    <Route path="/admin/support" element={requireAdmin(<AdminSupport data={data} update={update} />)} />
    <Route path="*" element={<NotFound />} />
  </Routes></>;
}

-- Evergreen shared demo storage. Run this once in Supabase SQL Editor.
-- This is a classroom simulation, not a real banking system.

create table if not exists public.evergreen_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.account_directory (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  account_number text not null unique,
  status text not null default 'Active',
  updated_at timestamptz not null default now()
);

alter table public.evergreen_accounts enable row level security;
alter table public.account_directory enable row level security;

drop policy if exists "Account owner or admin can read account data" on public.evergreen_accounts;
create policy "Account owner or admin can read account data"
  on public.evergreen_accounts for select to authenticated
  using (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'admin123@gmail.com');

drop policy if exists "Account owner or admin can create account data" on public.evergreen_accounts;
create policy "Account owner or admin can create account data"
  on public.evergreen_accounts for insert to authenticated
  with check (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'admin123@gmail.com');

drop policy if exists "Account owner or admin can update account data" on public.evergreen_accounts;
create policy "Account owner or admin can update account data"
  on public.evergreen_accounts for update to authenticated
  using (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'admin123@gmail.com')
  with check (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'admin123@gmail.com');

drop policy if exists "Signed-in users can view account directory" on public.account_directory;
create policy "Signed-in users can view account directory"
  on public.account_directory for select to authenticated using (true);

drop policy if exists "Owner or admin can add account directory entry" on public.account_directory;
create policy "Owner or admin can add account directory entry"
  on public.account_directory for insert to authenticated
  with check (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'admin123@gmail.com');

drop policy if exists "Owner or admin can update account directory entry" on public.account_directory;
create policy "Owner or admin can update account directory entry"
  on public.account_directory for update to authenticated
  using (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'admin123@gmail.com')
  with check (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'admin123@gmail.com');

grant select, insert, update on public.evergreen_accounts to authenticated;
grant select, insert, update on public.account_directory to authenticated;

-- Keep transfers atomic so the sender and recipient see the same result on every browser.
create or replace function public.evergreen_transfer(
  p_sender_id uuid,
  p_recipient_id uuid,
  p_amount numeric,
  p_note text default 'Evergreen transfer'
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sender_payload jsonb;
  recipient_payload jsonb;
  sender_profile jsonb;
  recipient_profile jsonb;
  sender_balance numeric;
  recipient_balance numeric;
  sender_name text;
  recipient_name text;
  recipient_status text;
  transaction_date text := now()::text;
  sender_transaction jsonb;
  recipient_transaction jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_sender_id then
    raise exception 'You can only transfer from your signed-in Evergreen account.';
  end if;
  if p_sender_id = p_recipient_id or p_amount is null or p_amount <= 0 then
    raise exception 'Enter a valid recipient and amount.';
  end if;

  select payload into sender_payload from public.evergreen_accounts where user_id = p_sender_id for update;
  select payload into recipient_payload from public.evergreen_accounts where user_id = p_recipient_id for update;
  select status into recipient_status from public.account_directory where user_id = p_recipient_id;
  if sender_payload is null or recipient_payload is null or recipient_status <> 'Active' then
    raise exception 'The recipient account is unavailable.';
  end if;

  sender_profile := sender_payload -> 'profile';
  recipient_profile := recipient_payload -> 'profile';
  sender_balance := coalesce((sender_profile ->> 'balance')::numeric, 0);
  recipient_balance := coalesce((recipient_profile ->> 'balance')::numeric, 0);
  sender_name := coalesce(sender_profile ->> 'name', 'Customer');
  recipient_name := coalesce(recipient_profile ->> 'name', 'Customer');
  if sender_profile ->> 'status' <> 'Active' or sender_profile ->> 'role' <> 'user' then
    raise exception 'This Evergreen account cannot send payments.';
  end if;
  if p_amount <> round(p_amount, 2) then raise exception 'Use an amount with up to two decimal places.'; end if;
  if sender_balance < p_amount then raise exception 'Your balance is not enough for this transfer.'; end if;

  sender_transaction := jsonb_build_object('id', gen_random_uuid()::text, 'userId', p_sender_id::text, 'kind', 'debit', 'title', 'Transfer to ' || recipient_name, 'amount', round(p_amount, 2), 'note', coalesce(p_note, 'Evergreen transfer'), 'date', transaction_date);
  recipient_transaction := jsonb_build_object('id', gen_random_uuid()::text, 'userId', p_recipient_id::text, 'kind', 'credit', 'title', 'Transfer from ' || sender_name, 'amount', round(p_amount, 2), 'note', coalesce(p_note, 'Evergreen transfer'), 'date', transaction_date);
  sender_payload := jsonb_set(sender_payload, '{profile,balance}', to_jsonb(round(sender_balance - p_amount, 2)), true);
  recipient_payload := jsonb_set(recipient_payload, '{profile,balance}', to_jsonb(round(recipient_balance + p_amount, 2)), true);
  sender_payload := jsonb_set(sender_payload, '{transactions}', jsonb_build_array(sender_transaction) || coalesce(sender_payload -> 'transactions', '[]'::jsonb), true);
  recipient_payload := jsonb_set(recipient_payload, '{transactions}', jsonb_build_array(recipient_transaction) || coalesce(recipient_payload -> 'transactions', '[]'::jsonb), true);

  update public.evergreen_accounts set payload = sender_payload, updated_at = now() where user_id = p_sender_id;
  update public.evergreen_accounts set payload = recipient_payload, updated_at = now() where user_id = p_recipient_id;
end;
$$;

revoke all on function public.evergreen_transfer(uuid, uuid, numeric, text) from public;
grant execute on function public.evergreen_transfer(uuid, uuid, numeric, text) to authenticated;

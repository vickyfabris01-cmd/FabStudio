-- FabStudio: sign-in required (no guest mode).
-- ACTION: run ONCE in Supabase > SQL Editor, after 010. Safe to run again.
--
-- Supabase gives anonymous (guest) sessions the same "authenticated" role as real accounts, so the old
-- policies let them in. This adds one check, "is a real account", to everything a visitor can write.
-- Reading stays public: the poems list and the comments are still visible to people who are not signed in.

create or replace function public.is_member() returns boolean
language sql stable set search_path = public
as $$ select auth.uid() is not null and not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) $$;

grant execute on function public.is_member() to anon, authenticated;

-- Reactions: only real accounts may add or change one.
drop policy if exists "add own reaction" on public.reactions;
create policy "add own reaction" on public.reactions for insert to authenticated
  with check (public.is_member() and user_id = auth.uid() and not public.is_blocked() and public.item_allows_reactions(item_id));

drop policy if exists "change own reaction" on public.reactions;
create policy "change own reaction" on public.reactions for update to authenticated
  using (user_id = auth.uid())
  with check (public.is_member() and user_id = auth.uid() and not public.is_blocked() and public.item_allows_reactions(item_id));

-- Comments: only real accounts may write one.
drop policy if exists "add own comment" on public.comments;
create policy "add own comment" on public.comments for insert to authenticated
  with check (public.is_member() and user_id = auth.uid() and not public.is_blocked() and public.item_allows_comments(item_id));

-- Views: only real accounts are counted.
create or replace function public.record_view(p_item uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare added int;
begin
  if auth.uid() is null or not public.is_member() or not public.item_published(p_item) or public.is_blocked() then return; end if;
  insert into public.views (item_id, user_id) values (p_item, auth.uid()) on conflict do nothing;
  get diagnostics added = row_count;
  if added > 0 then
    update public.counters set n_views = n_views + 1 where item_id = p_item;
  end if;
end $$;

revoke all on function public.record_view(uuid) from public;
grant execute on function public.record_view(uuid) to authenticated;

-- Old guest data (views, reactions, comments) stays as it is. A returning guest who signs in still has it merged
-- into their account by the Worker (/viewer/merge), so nothing needs to be moved here.

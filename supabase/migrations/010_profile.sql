-- FabStudio: viewer profile page (change name, delete account).
-- ACTION: run ONCE in Supabase > SQL Editor, after 009. Safe to run again.

-- Changes the name a signed-in viewer shows. Also renames their existing comments, so old and new comments match.
-- Returns the cleaned name (extra spaces removed) so the page can store exactly the same text.
create or replace function public.set_display_name(p_name text) returns text
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  nm text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  nm := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if char_length(nm) not between 1 and 30 then raise exception 'bad name'; end if;
  insert into public.viewer_profiles (user_id, nickname) values (uid, nm)
    on conflict (user_id) do update set nickname = excluded.nickname;
  update public.comments set nickname = nm where user_id = uid;
  return nm;
end $$;

-- Deletes the caller's own account and what they wrote: comments, reactions, views, Love taps and profile.
-- Refuses guests (nothing to delete) and the owner account (so it cannot be removed by a stray tap).
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in'; end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then raise exception 'guest accounts cannot be deleted here'; end if;
  if public.is_owner() then raise exception 'the owner account cannot be deleted here'; end if;
  delete from public.comments  where user_id = uid;
  delete from public.reactions where user_id = uid;
  delete from public.views     where user_id = uid;
  delete from public.live_love where user_id = uid;
  delete from public.viewer_profiles where user_id = uid;
  delete from auth.users where id = uid;
end $$;

revoke all on function public.set_display_name(text), public.delete_my_account() from public, anon;
grant execute on function public.set_display_name(text), public.delete_my_account() to authenticated;

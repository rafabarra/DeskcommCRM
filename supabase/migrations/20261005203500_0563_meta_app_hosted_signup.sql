-- 0563 · Configuração server-side para o Hosted Embedded Signup da Meta.
--
-- Esta fatia só prepara o App da Meta da INSTALAÇÃO para o próximo passo:
-- callback OAuth e troca de code por token NÃO entram aqui. `app_id` é público
-- e pode cair para META_APP_ID no resolvedor; `hosted_signup_url` não tem
-- fallback de browser nem de ambiente — a autoridade é a linha salva pelo
-- platform admin. App Secret e verify token continuam cifrados e intocados.
--
-- A tabela segue singleton e server-side only. Não há organização no input nem
-- tabela tenant-aware nova: um App da Meta atende a instalação inteira.

alter table public.platform_meta_app
  add column if not exists app_id text,
  add column if not exists hosted_signup_url text;

comment on column public.platform_meta_app.app_id is
  'ID público do App da Meta desta instalação. O banco prevalece; META_APP_ID é apenas fallback legado do servidor.';

comment on column public.platform_meta_app.hosted_signup_url is
  'URL HTTPS pública do Cadastro Incorporado hospedado pela Meta. Configurada pelo platform admin e resolvida do banco; nunca aceita como autoridade direta do browser.';

notify pgrst, 'reload schema';

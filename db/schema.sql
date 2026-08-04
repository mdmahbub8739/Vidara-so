-- Complete, Stretched PostgreSQL / Supabase Schema
-- Includes Users, Content, Taxonomy, Media Links, Engagement, and Crawler Queues

-- ==========================================
-- 1. EXTENSIONS & ENUMS
-- ==========================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('admin', 'moderator', 'creator', 'user');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'post_status') THEN
    CREATE TYPE post_status AS ENUM ('draft', 'published', 'archived', 'flagged', 'dmca_takedown');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_status') THEN
    CREATE TYPE link_status AS ENUM ('active', 'broken', 'processing', 'offline');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_type') THEN
    CREATE TYPE link_type AS ENUM ('embed', 'direct_mp4', 'hls_m3u8', 'torrent', 'download');
  END IF;
END $$;

-- ==========================================
-- 2. USERS & PROFILES
-- ==========================================
CREATE TABLE IF NOT EXISTS public.users (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  username character varying NOT NULL UNIQUE,
  email character varying NOT NULL UNIQUE,
  password_hash character varying NOT NULL,
  role user_role DEFAULT 'user',
  is_active boolean DEFAULT true,
  is_verified boolean DEFAULT false,
  last_login_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id uuid NOT NULL,
  display_name character varying,
  avatar_url text,
  bio text,
  website text,
  preferences jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT user_profiles_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ==========================================
-- 3. TAXONOMY (Tags, Categories, Actors, Studios)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.categories (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying NOT NULL UNIQUE,
  slug character varying NOT NULL UNIQUE,
  description text,
  parent_id uuid REFERENCES public.categories(id),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT categories_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.tags (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying NOT NULL UNIQUE,
  slug character varying NOT NULL UNIQUE,
  is_trending boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tags_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.actors (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying NOT NULL UNIQUE,
  slug character varying NOT NULL UNIQUE,
  bio text,
  avatar_url text,
  gender character varying(50),
  birth_date date,
  nationality character varying(100),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT actors_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.studios (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying NOT NULL UNIQUE,
  slug character varying NOT NULL UNIQUE,
  website_url text,
  logo_url text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT studios_pkey PRIMARY KEY (id)
);

-- ==========================================
-- 4. CORE POSTS
-- ==========================================
CREATE TABLE IF NOT EXISTS public.posts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid, -- Uploader/Creator
  external_id character varying UNIQUE, -- ID from scraped sources
  title character varying NOT NULL,
  slug character varying NOT NULL UNIQUE,
  description text,
  
  -- Media Metadata
  thumbnail_url text,
  poster_url text,
  duration_seconds integer,
  duration_formatted character varying(20), -- e.g., "01:23:45"
  max_resolution character varying(20), -- e.g., "1080p", "4K"
  fps integer DEFAULT 30,
  
  -- State
  status post_status DEFAULT 'draft',
  visibility character varying DEFAULT 'public',
  is_premium boolean DEFAULT false,
  
  -- Metrics (Aggregated for fast sorting)
  view_count bigint DEFAULT 0,
  like_count bigint DEFAULT 0,
  comment_count bigint DEFAULT 0,
  
  -- Timestamps
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  published_at timestamp with time zone,
  CONSTRAINT posts_pkey PRIMARY KEY (id),
  CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL
);

-- Ensure thumbnail_url exists if table already existed
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS thumbnail_url text;

-- ==========================================
-- 5. RELATIONSHIPS (Many-to-Many)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.post_categories (
  post_id uuid NOT NULL,
  category_id uuid NOT NULL,
  CONSTRAINT post_categories_pkey PRIMARY KEY (post_id, category_id),
  CONSTRAINT post_categories_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT post_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.post_tags (
  post_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  CONSTRAINT post_tags_pkey PRIMARY KEY (post_id, tag_id),
  CONSTRAINT post_tags_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT post_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.post_actors (
  post_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  role_name character varying, -- optional character name
  CONSTRAINT post_actors_pkey PRIMARY KEY (post_id, actor_id),
  CONSTRAINT post_actors_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT post_actors_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.post_studios (
  post_id uuid NOT NULL,
  studio_id uuid NOT NULL,
  CONSTRAINT post_studios_pkey PRIMARY KEY (post_id, studio_id),
  CONSTRAINT post_studios_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT post_studios_studio_id_fkey FOREIGN KEY (studio_id) REFERENCES public.studios(id) ON DELETE CASCADE
);

-- ==========================================
-- 6. MEDIA LINKS & EMBEDS
-- ==========================================
CREATE TABLE IF NOT EXISTS public.post_links (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  post_id uuid NOT NULL,
  link_type link_type NOT NULL,
  provider_domain character varying, -- e.g., 'doodstream', 'mixdrop', 'cloudflare'
  file_code character varying, -- External identifier for the file
  url text NOT NULL,
  quality character varying(20), -- e.g., '360p', '720p', '1080p', '4K'
  server_location character varying(50), -- e.g., 'EU', 'US-East'
  has_ads boolean DEFAULT true,
  status link_status DEFAULT 'active',
  last_checked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT post_links_pkey PRIMARY KEY (id),
  CONSTRAINT post_links_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE
);

-- ==========================================
-- 7. ENGAGEMENT & USER INTERACTION
-- ==========================================
CREATE TABLE IF NOT EXISTS public.post_likes (
  user_id uuid NOT NULL,
  post_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT post_likes_pkey PRIMARY KEY (user_id, post_id),
  CONSTRAINT post_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT post_likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.post_views (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  post_id uuid NOT NULL,
  user_id uuid, -- Nullable for anonymous views
  ip_hash character varying, -- Anonymized IP hash
  user_agent text,
  viewed_duration_seconds integer,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT post_views_pkey PRIMARY KEY (id),
  CONSTRAINT post_views_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.comments (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  parent_id uuid REFERENCES public.comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  is_approved boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT comments_pkey PRIMARY KEY (id),
  CONSTRAINT comments_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.watch_later (
  user_id uuid NOT NULL,
  post_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT watch_later_pkey PRIMARY KEY (user_id, post_id),
  CONSTRAINT watch_later_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT watch_later_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE
);

-- ==========================================
-- 8. CRAWLER & SCRAPING ENGINE
-- ==========================================
-- Unified posts staging area for raw scraped data
CREATE TABLE IF NOT EXISTS public.unified_posts (
  post_id text NOT NULL,
  title text NOT NULL,
  description text,
  categories jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  actors jsonb DEFAULT '[]'::jsonb,
  studios jsonb DEFAULT '[]'::jsonb,
  original_url text,
  thumbnail_url text,
  duration character varying(20),
  resolution character varying(20),
  embeds jsonb DEFAULT '[]'::jsonb,
  direct_links jsonb DEFAULT '[]'::jsonb,
  m3u8_links jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  is_processed boolean DEFAULT false, -- Whether it's been imported into main posts table
  CONSTRAINT unified_posts_pkey PRIMARY KEY (post_id)
);

ALTER TABLE public.unified_posts ADD COLUMN IF NOT EXISTS thumbnail_url text;

CREATE TABLE IF NOT EXISTS public.crawl_checkpoint (
  id text NOT NULL DEFAULT 'default'::text,
  last_url text,
  next_url text,
  pages_crawled_total integer NOT NULL DEFAULT 0,
  items_scraped_total integer NOT NULL DEFAULT 0,
  consecutive_duplicate_pages integer NOT NULL DEFAULT 0,
  last_error text,
  last_error_at timestamp with time zone,
  started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT crawl_checkpoint_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.crawler_queue (
  post_id text NOT NULL,
  title text NOT NULL,
  categories jsonb DEFAULT '[]'::jsonb,
  actors jsonb DEFAULT '[]'::jsonb,
  original_url text,
  thumbnail_url text,
  original_embeds jsonb DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'PENDING'::text, -- PENDING, PROCESSING, COMPLETED, FAILED
  final_embeds jsonb DEFAULT '[]'::jsonb,
  final_direct_links jsonb DEFAULT '[]'::jsonb,
  logs jsonb DEFAULT '[]'::jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  batch_id text,
  error_msg text,
  retry_count integer DEFAULT 0,
  CONSTRAINT crawler_queue_pkey PRIMARY KEY (post_id)
);

ALTER TABLE public.crawler_queue ADD COLUMN IF NOT EXISTS thumbnail_url text;

CREATE TABLE IF NOT EXISTS public.crawler_failed_items (
  post_id text NOT NULL,
  title text NOT NULL,
  categories jsonb DEFAULT '[]'::jsonb,
  actors jsonb DEFAULT '[]'::jsonb,
  original_url text,
  thumbnail_url text,
  original_embeds jsonb DEFAULT '[]'::jsonb,
  error_msg text,
  error_stack text,
  batch_id text,
  failed_at bigint NOT NULL,
  CONSTRAINT crawler_failed_items_pkey PRIMARY KEY (post_id)
);

ALTER TABLE public.crawler_failed_items ADD COLUMN IF NOT EXISTS thumbnail_url text;

-- ==========================================
-- 9. PERFORMANCE INDEXES
-- ==========================================
-- Posts & Taxonomy Searching
CREATE INDEX IF NOT EXISTS idx_posts_status ON public.posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON public.posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_view_count ON public.posts(view_count DESC);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON public.posts(slug);
CREATE INDEX IF NOT EXISTS idx_tags_slug ON public.tags(slug);
CREATE INDEX IF NOT EXISTS idx_categories_slug ON public.categories(slug);
CREATE INDEX IF NOT EXISTS idx_actors_slug ON public.actors(slug);
CREATE INDEX IF NOT EXISTS idx_studios_slug ON public.studios(slug);

-- Links
CREATE INDEX IF NOT EXISTS idx_post_links_post_id ON public.post_links(post_id);
CREATE INDEX IF NOT EXISTS idx_post_links_provider ON public.post_links(provider_domain);

-- Unified Posts (for crawler lookups)
CREATE INDEX IF NOT EXISTS idx_unified_posts_is_processed ON public.unified_posts(is_processed);

-- Triggers for updated_at
CREATE OR REPLACE FUNCTION update_modified_column()   
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;   
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_modtime ON public.users;
CREATE TRIGGER update_users_modtime BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_posts_modtime ON public.posts;
CREATE TRIGGER update_posts_modtime BEFORE UPDATE ON public.posts FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_post_links_modtime ON public.post_links;
CREATE TRIGGER update_post_links_modtime BEFORE UPDATE ON public.post_links FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_unified_posts_modtime ON public.unified_posts;
CREATE TRIGGER update_unified_posts_modtime BEFORE UPDATE ON public.unified_posts FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

DROP TRIGGER IF EXISTS update_crawl_checkpoint_modtime ON public.crawl_checkpoint;
CREATE TRIGGER update_crawl_checkpoint_modtime BEFORE UPDATE ON public.crawl_checkpoint FOR EACH ROW EXECUTE PROCEDURE update_modified_column();


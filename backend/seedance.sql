--
-- PostgreSQL database dump
--

\restrict ldDDctbH2uQr9DlQyLWEIFlOPUNMpyPly2QN3zoLLCUrEG56p414wob7hIutNWu

-- Dumped from database version 18.4 (Ubuntu 18.4-1.pgdg22.04+1)
-- Dumped by pg_dump version 18.4 (Ubuntu 18.4-1.pgdg22.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: project_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    label character varying(100) NOT NULL,
    description text,
    image_url text,
    asset_id character varying(100),
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    action_url text,
    sound_url text
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    cover_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: shots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id uuid NOT NULL,
    shot_number integer NOT NULL,
    title character varying(255),
    description text,
    prompt text,
    subtitle text,
    duration numeric(5,2) DEFAULT 8,
    ratio character varying(10),
    mood character varying(100),
    camera_movement character varying(100),
    camera_position_x numeric(10,4) DEFAULT 0,
    camera_position_y numeric(10,4) DEFAULT 5,
    camera_position_z numeric(10,4) DEFAULT 10,
    camera_target_x numeric(10,4) DEFAULT 0,
    camera_target_y numeric(10,4) DEFAULT 0,
    camera_target_z numeric(10,4) DEFAULT 0,
    camera_fov numeric(5,2) DEFAULT 60,
    camera_movement_type character varying(20) DEFAULT 'static'::character varying,
    camera_movement_path jsonb,
    reference_images jsonb DEFAULT '[]'::jsonb,
    subjects jsonb DEFAULT '[]'::jsonb,
    task_id character varying(100),
    task_status character varying(20) DEFAULT 'idle'::character varying,
    video_url text,
    local_url text,
    video_duration numeric(5,2),
    task_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    shot_type character varying(30),
    lighting character varying(30)
);


--
-- Name: user_asset_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_asset_groups (
    id integer NOT NULL,
    user_id integer,
    group_id character varying(100) NOT NULL,
    group_type character varying(20) NOT NULL,
    name character varying(200),
    shared boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_asset_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_asset_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_asset_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_asset_groups_id_seq OWNED BY public.user_asset_groups.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    sso_user_id integer NOT NULL,
    username character varying(50),
    name character varying(100),
    email character varying(200),
    avatar text,
    quota integer DEFAULT 10,
    used integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: video_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id uuid NOT NULL,
    media_type character varying(10) NOT NULL,
    url text NOT NULL,
    name character varying(255),
    preview_url text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    description text
);


--
-- Name: video_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: videos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.videos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id integer NOT NULL,
    name character varying(255) NOT NULL,
    script text,
    subtitle_input text,
    style character varying(500),
    ratio character varying(10) DEFAULT '9:16'::character varying,
    seed integer,
    params jsonb DEFAULT '{}'::jsonb,
    voice character varying(100),
    audio_url text,
    merged_video_url text,
    sort_order integer DEFAULT 0,
    status character varying(20) DEFAULT 'draft'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_asset_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_asset_groups ALTER COLUMN id SET DEFAULT nextval('public.user_asset_groups_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: project_subjects project_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_subjects
    ADD CONSTRAINT project_subjects_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: shots shots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shots
    ADD CONSTRAINT shots_pkey PRIMARY KEY (id);


--
-- Name: user_asset_groups user_asset_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_asset_groups
    ADD CONSTRAINT user_asset_groups_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_sso_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_sso_user_id_key UNIQUE (sso_user_id);


--
-- Name: video_media video_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_media
    ADD CONSTRAINT video_media_pkey PRIMARY KEY (id);


--
-- Name: video_subjects video_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_subjects
    ADD CONSTRAINT video_subjects_pkey PRIMARY KEY (id);


--
-- Name: video_subjects video_subjects_video_id_subject_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_subjects
    ADD CONSTRAINT video_subjects_video_id_subject_id_key UNIQUE (video_id, subject_id);


--
-- Name: videos videos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.videos
    ADD CONSTRAINT videos_pkey PRIMARY KEY (id);


--
-- Name: idx_project_subjects_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_subjects_project ON public.project_subjects USING btree (project_id);


--
-- Name: idx_projects_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_user ON public.projects USING btree (user_id);


--
-- Name: idx_shots_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shots_video ON public.shots USING btree (video_id);


--
-- Name: idx_shots_video_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_shots_video_order ON public.shots USING btree (video_id, shot_number);


--
-- Name: idx_user_asset_groups_shared_group; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_asset_groups_shared_group ON public.user_asset_groups USING btree (group_id) WHERE (shared = true);


--
-- Name: idx_user_asset_groups_user_group; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_asset_groups_user_group ON public.user_asset_groups USING btree (user_id, group_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_video_media_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_video_media_video ON public.video_media USING btree (video_id);


--
-- Name: idx_video_subjects_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_video_subjects_video ON public.video_subjects USING btree (video_id);


--
-- Name: idx_videos_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_videos_project ON public.videos USING btree (project_id);


--
-- Name: idx_videos_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_videos_user ON public.videos USING btree (user_id);


--
-- Name: project_subjects project_subjects_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_subjects
    ADD CONSTRAINT project_subjects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: shots shots_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shots
    ADD CONSTRAINT shots_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.videos(id) ON DELETE CASCADE;


--
-- Name: user_asset_groups user_asset_groups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_asset_groups
    ADD CONSTRAINT user_asset_groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: video_media video_media_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_media
    ADD CONSTRAINT video_media_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.videos(id) ON DELETE CASCADE;


--
-- Name: video_subjects video_subjects_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_subjects
    ADD CONSTRAINT video_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.project_subjects(id) ON DELETE CASCADE;


--
-- Name: video_subjects video_subjects_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_subjects
    ADD CONSTRAINT video_subjects_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.videos(id) ON DELETE CASCADE;


--
-- Name: videos videos_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.videos
    ADD CONSTRAINT videos_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: videos videos_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.videos
    ADD CONSTRAINT videos_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict ldDDctbH2uQr9DlQyLWEIFlOPUNMpyPly2QN3zoLLCUrEG56p414wob7hIutNWu


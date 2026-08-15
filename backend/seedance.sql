--
-- PostgreSQL database dump
--

\restrict pz2yVvdxDsQ4xNAOVFRd3JZaa7Ysr3SGQMxeywv2SFrdjVrAtzklkw900VldVJe

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
-- Name: batch_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.batch_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    script text,
    style character varying(50),
    ratio character varying(10),
    seed integer,
    shots jsonb DEFAULT '[]'::jsonb,
    media_items jsonb DEFAULT '[]'::jsonb,
    params jsonb DEFAULT '{}'::jsonb,
    subject_defs text,
    subtitle_input text,
    tasks jsonb DEFAULT '{}'::jsonb,
    merged_video_url text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    init_result jsonb DEFAULT '{}'::jsonb,
    user_id integer
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
-- Name: user_asset_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_asset_groups ALTER COLUMN id SET DEFAULT nextval('public.user_asset_groups_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: batch_tasks batch_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_tasks
    ADD CONSTRAINT batch_tasks_pkey PRIMARY KEY (id);


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
-- Name: idx_user_asset_groups_shared_group; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_asset_groups_shared_group ON public.user_asset_groups USING btree (group_id) WHERE (shared = true);


--
-- Name: idx_user_asset_groups_user_group; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_asset_groups_user_group ON public.user_asset_groups USING btree (user_id, group_id) WHERE (user_id IS NOT NULL);


--
-- Name: batch_tasks batch_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_tasks
    ADD CONSTRAINT batch_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_asset_groups user_asset_groups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_asset_groups
    ADD CONSTRAINT user_asset_groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict pz2yVvdxDsQ4xNAOVFRd3JZaa7Ysr3SGQMxeywv2SFrdjVrAtzklkw900VldVJe


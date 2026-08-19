-- 提示词/资料库表（并入自 fenjing-script）
-- 建表：psql $DATABASE_URL -f backend/db/lib_schema.sql
-- 种子数据不在此文件内，从 seedance_script 库导入（见 CLAUDE.md）



CREATE TABLE public.lib_fragments (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying(200) NOT NULL,
    type character varying(50) NOT NULL,
    content_en text NOT NULL,
    content_zh text,
    tags text[],
    use_count integer DEFAULT 0,
    is_builtin boolean DEFAULT true
);

CREATE SEQUENCE public.lib_fragments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lib_fragments_id_seq OWNED BY public.lib_fragments.id;

CREATE TABLE public.lib_insurance_cases (
    id integer NOT NULL,
    source_id integer,
    title text NOT NULL,
    tags text[] DEFAULT '{}'::text[],
    customer_age integer,
    family_structure text,
    insurance_needs text,
    description text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text,
    key_points jsonb DEFAULT '[]'::jsonb,
    budget_suggestion text DEFAULT ''::text,
    is_featured boolean DEFAULT false,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.lib_insurance_cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lib_insurance_cases_id_seq OWNED BY public.lib_insurance_cases.id;

CREATE TABLE public.lib_insurance_qa (
    id integer NOT NULL,
    source_id integer,
    title text NOT NULL,
    tags text[] DEFAULT '{}'::text[],
    content text DEFAULT ''::text NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.lib_insurance_qa_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lib_insurance_qa_id_seq OWNED BY public.lib_insurance_qa.id;

CREATE TABLE public.lib_prompt_templates (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying(200) NOT NULL,
    category character varying(100),
    description_zh text,
    prompt_en text NOT NULL,
    subject_hint text,
    action_hint text,
    scene_hint text,
    camera text,
    composition text,
    style text,
    lighting text,
    color_tone text,
    duration text,
    tags text[],
    use_count integer DEFAULT 0,
    is_builtin boolean DEFAULT true
);

CREATE SEQUENCE public.lib_prompt_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lib_prompt_templates_id_seq OWNED BY public.lib_prompt_templates.id;

CREATE TABLE public.lib_shot_presets (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying(200) NOT NULL,
    category character varying(100),
    camera_move text,
    shot_type text,
    composition text,
    lighting text,
    color_tone text,
    style text,
    quality text,
    fragment_en text,
    description_zh text,
    tags text[],
    use_count integer DEFAULT 0,
    is_builtin boolean DEFAULT true
);

CREATE SEQUENCE public.lib_shot_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lib_shot_presets_id_seq OWNED BY public.lib_shot_presets.id;

CREATE TABLE public.lib_style_presets (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying(200) NOT NULL,
    category character varying(100),
    style text,
    lighting text,
    color_tone text,
    quality text,
    fragment_en text,
    description_zh text,
    tags text[],
    use_count integer DEFAULT 0,
    is_builtin boolean DEFAULT true
);

CREATE SEQUENCE public.lib_style_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lib_style_presets_id_seq OWNED BY public.lib_style_presets.id;

ALTER TABLE ONLY public.lib_fragments ALTER COLUMN id SET DEFAULT nextval('public.lib_fragments_id_seq'::regclass);

ALTER TABLE ONLY public.lib_insurance_cases ALTER COLUMN id SET DEFAULT nextval('public.lib_insurance_cases_id_seq'::regclass);

ALTER TABLE ONLY public.lib_insurance_qa ALTER COLUMN id SET DEFAULT nextval('public.lib_insurance_qa_id_seq'::regclass);

ALTER TABLE ONLY public.lib_prompt_templates ALTER COLUMN id SET DEFAULT nextval('public.lib_prompt_templates_id_seq'::regclass);

ALTER TABLE ONLY public.lib_shot_presets ALTER COLUMN id SET DEFAULT nextval('public.lib_shot_presets_id_seq'::regclass);

ALTER TABLE ONLY public.lib_style_presets ALTER COLUMN id SET DEFAULT nextval('public.lib_style_presets_id_seq'::regclass);

ALTER TABLE ONLY public.lib_fragments
    ADD CONSTRAINT lib_fragments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lib_insurance_cases
    ADD CONSTRAINT lib_insurance_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lib_insurance_qa
    ADD CONSTRAINT lib_insurance_qa_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lib_prompt_templates
    ADD CONSTRAINT lib_prompt_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lib_shot_presets
    ADD CONSTRAINT lib_shot_presets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lib_style_presets
    ADD CONSTRAINT lib_style_presets_pkey PRIMARY KEY (id);

CREATE INDEX lib_idx_fragments_type ON public.lib_fragments USING btree (type);

CREATE INDEX lib_idx_iqa_tags ON public.lib_insurance_qa USING gin (tags);

CREATE INDEX lib_idx_lib_ic_featured ON public.lib_insurance_cases USING btree (is_featured);

CREATE INDEX lib_idx_lib_ic_sort ON public.lib_insurance_cases USING btree (sort_order);

CREATE INDEX lib_idx_lib_ic_tags ON public.lib_insurance_cases USING gin (tags);

CREATE INDEX lib_idx_prompt_templates_category ON public.lib_prompt_templates USING btree (category);

CREATE INDEX lib_idx_shot_presets_category ON public.lib_shot_presets USING btree (category);

CREATE INDEX lib_idx_style_presets_category ON public.lib_style_presets USING btree (category);



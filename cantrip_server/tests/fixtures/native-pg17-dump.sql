--
-- PostgreSQL database dump
--

\restrict CantripNativeDumpProbe42

-- Dumped from database version 17.5
-- Dumped by pg_dump version 17.9 (Homebrew)

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
-- Name: native_probe(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.native_probe() RETURNS text
    LANGUAGE sql
    AS $_$ SELECT $literal$before
\restrict CantripNativeDumpProbe42
middle
\unrestrict CantripNativeDumpProbe42
after 🦀$literal$::text $_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: native_probe; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.native_probe (
    id bigint NOT NULL,
    value text,
    metadata jsonb,
    precise numeric,
    bytes bytea
);


--
-- Data for Name: native_probe; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.native_probe VALUES (9007199254740993, 'before
\restrict CantripNativeDumpProbe42
middle
\unrestrict CantripNativeDumpProbe42
after 🦀', NULL, 123456789012345678901234567890.12345, '\x00ff');
INSERT INTO public.native_probe VALUES (2, 'JSON null', 'null', NULL, NULL);


--
-- Name: native_probe native_probe_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.native_probe
    ADD CONSTRAINT native_probe_pkey PRIMARY KEY (id);


--
-- PostgreSQL database dump complete
--

\unrestrict CantripNativeDumpProbe42

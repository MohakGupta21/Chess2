-- Runs once when the docker-compose Postgres volume is first created.
-- The default database `chess` is created by the image from POSTGRES_DB.
CREATE DATABASE chess_test;

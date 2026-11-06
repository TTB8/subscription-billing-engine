-- Separate database so e2e tests never touch development data.
CREATE DATABASE billing_test OWNER billing;

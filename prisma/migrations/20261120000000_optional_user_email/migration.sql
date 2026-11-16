-- A managed account can use a username without binding an email address.
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

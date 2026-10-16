-- Removed team folders / external storages: the row stays (status ignored) so discovery does not
-- re-create the space from its still existing folder.
ALTER TYPE "SpaceStatus" ADD VALUE 'ignored';

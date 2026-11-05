/* Prints the sizes and offsets of the libfuse structures the C# interop layer mirrors (name=value per line). */
#define FUSE_USE_VERSION 34
#include <fuse_lowlevel.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/statvfs.h>

#define P(name, value) printf("%s=%zu\n", name, (size_t)(value))
#define OPS(field) P("ops." #field, offsetof(struct fuse_lowlevel_ops, field))

int main(void) {
    P("sizeof_stat", sizeof(struct stat));
    P("stat.ino", offsetof(struct stat, st_ino));
    P("stat.mode", offsetof(struct stat, st_mode));
    P("stat.nlink", offsetof(struct stat, st_nlink));
    P("stat.uid", offsetof(struct stat, st_uid));
    P("stat.gid", offsetof(struct stat, st_gid));
    P("stat.size", offsetof(struct stat, st_size));
    P("stat.blksize", offsetof(struct stat, st_blksize));
    P("stat.blocks", offsetof(struct stat, st_blocks));
    P("stat.atim", offsetof(struct stat, st_atim));
    P("stat.mtim", offsetof(struct stat, st_mtim));
    P("stat.ctim", offsetof(struct stat, st_ctim));

    P("sizeof_entry_param", sizeof(struct fuse_entry_param));
    P("entry.ino", offsetof(struct fuse_entry_param, ino));
    P("entry.generation", offsetof(struct fuse_entry_param, generation));
    P("entry.attr", offsetof(struct fuse_entry_param, attr));
    P("entry.attr_timeout", offsetof(struct fuse_entry_param, attr_timeout));
    P("entry.entry_timeout", offsetof(struct fuse_entry_param, entry_timeout));

    P("sizeof_file_info", sizeof(struct fuse_file_info));
    P("fi.flags", offsetof(struct fuse_file_info, flags));
    P("fi.fh", offsetof(struct fuse_file_info, fh));
#if FUSE_MINOR_VERSION >= 17
    P("fi.backing_id", offsetof(struct fuse_file_info, backing_id));
    P("fi.compat_flags", offsetof(struct fuse_file_info, compat_flags));
#endif

    P("sizeof_ops", offsetof(struct fuse_lowlevel_ops, lseek) + sizeof(void *));
    OPS(init); OPS(lookup); OPS(getattr); OPS(setattr); OPS(mkdir); OPS(unlink); OPS(rmdir);
    OPS(rename); OPS(open); OPS(read); OPS(write); OPS(release); OPS(readdir); OPS(statfs);
    OPS(create); OPS(ioctl); OPS(readdirplus); OPS(lseek);

    P("sizeof_args", sizeof(struct fuse_args));
    P("sizeof_statvfs", sizeof(struct statvfs));
    P("statvfs.bavail", offsetof(struct statvfs, f_bavail));
    P("statvfs.namemax", offsetof(struct statvfs, f_namemax));
    return 0;
}

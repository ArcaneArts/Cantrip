#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* Retain one nonprivileged parent per managed Run command. Orphaned descendants
 * are adopted here, so the native executor can still identify the complete
 * command tree after sudo/setsid/double forks. This adds no isolation or grants. */
static void keep_owner(int signal_number) { (void)signal_number; }

int main(int argc, char **argv) {
    if (argc < 2) { fputs("A Run command is required.\n", stderr); return 125; }
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == -1) {
        perror("Run child ownership"); return 125;
    }
    struct sigaction action = {0};
    action.sa_handler = keep_owner;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    const int signals[] = {SIGINT, SIGTERM, SIGHUP};
    for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
        if (sigaction(signals[i], &action, NULL) == -1) { perror("Run owner signal"); return 125; }
    }
    pid_t command = fork();
    if (command == -1) { perror("Run command fork"); return 125; }
    if (command == 0) {
        action.sa_handler = SIG_DFL;
        action.sa_flags = 0;
        for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++)
            if (sigaction(signals[i], &action, NULL) == -1) _exit(125);
        execvp(argv[1], argv + 1);
        perror("Run command exec");
        _exit(127);
    }
    int command_status = 0, observed = 0;
    for (;;) {
        int status;
        pid_t child = waitpid(-1, &status, 0);
        if (child == command) { command_status = status; observed = 1; }
        if (child > 0 || (child == -1 && errno == EINTR)) continue;
        if (child == -1 && errno == ECHILD) break;
        perror("Run descendant wait"); return 125;
    }
    if (!observed) return 125;
    return WIFEXITED(command_status) ? WEXITSTATUS(command_status)
        : WIFSIGNALED(command_status) ? 128 + WTERMSIG(command_status) : 125;
}

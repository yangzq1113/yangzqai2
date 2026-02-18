#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <exception>
#include <string>
#include <thread>
#include <vector>

#include "node.h"

static std::atomic<bool> g_node_running(false);
static constexpr const char* LOG_TAG = "LukerNative";

extern "C"
JNIEXPORT jint JNICALL
Java_com_luker_app_LukerRuntimeManager_startNodeWithArguments(JNIEnv *env, jobject /* this */, jobjectArray arguments) {
    if (g_node_running.exchange(true)) {
        __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "Node runtime already running, skip duplicate start.");
        return 0;
    }

    int argc = env->GetArrayLength(arguments);
    std::vector<std::string> args(argc);

    for (int i = 0; i < argc; i++) {
        jstring arg = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *arg_str = env->GetStringUTFChars(arg, nullptr);
        args[i] = arg_str;
        env->ReleaseStringUTFChars(arg, arg_str);
        env->DeleteLocalRef(arg);
    }

    try {
        __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "Starting Node runtime with argc=%d, script=%s", argc, argc > 1 ? args[1].c_str() : "<none>");
        std::thread([args = std::move(args)]() mutable {
            std::vector<char *> argv(args.size());
            for (size_t i = 0; i < args.size(); i++) {
                argv[i] = const_cast<char *>(args[i].c_str());
            }
            __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "Node thread entered.");
            int rc = node::Start(static_cast<int>(argv.size()), argv.data());
            __android_log_print(ANDROID_LOG_WARN, LOG_TAG, "Node runtime exited with code=%d", rc);
            g_node_running.store(false);
        }).detach();
    } catch (const std::exception& e) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "Failed to create Node thread: %s", e.what());
        g_node_running.store(false);
        return -1;
    } catch (...) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "Failed to create Node thread: unknown error");
        g_node_running.store(false);
        return -1;
    }

    return 0;
}

extern "C"
JNIEXPORT jboolean JNICALL
Java_com_luker_app_LukerRuntimeManager_isNodeProcessRunning(JNIEnv* /* env */, jobject /* this */) {
    return g_node_running.load() ? JNI_TRUE : JNI_FALSE;
}

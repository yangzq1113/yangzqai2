#include <jni.h>
#include <string>
#include <vector>

#include "node.h"

extern "C"
JNIEXPORT jint JNICALL
Java_com_luker_app_LukerRuntimeManager_startNodeWithArguments(JNIEnv *env, jobject /* this */, jobjectArray arguments) {
    int argc = env->GetArrayLength(arguments);
    std::vector<std::string> args(argc);
    std::vector<char *> argv(argc);

    for (int i = 0; i < argc; i++) {
        jstring arg = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *arg_str = env->GetStringUTFChars(arg, nullptr);
        args[i] = arg_str;
        argv[i] = const_cast<char *>(args[i].c_str());
        env->ReleaseStringUTFChars(arg, arg_str);
        env->DeleteLocalRef(arg);
    }

    return node::Start(argc, argv.data());
}

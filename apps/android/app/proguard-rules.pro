# 网页调用的 window.EmakiApp（WebScreen.kt）：方法名不能被混淆、不能被删
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

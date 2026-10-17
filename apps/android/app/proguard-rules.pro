# kotlinx.serialization: vom Plugin erzeugte Serializer (DTOs, typsichere Navigationsrouten, Warteschlange)
-keepattributes *Annotation*, InnerClasses, Signature
-dontnote kotlinx.serialization.**
-keepclassmembers class tech.jensk.synclet.** { *** Companion; }
-keepclasseswithmembers class tech.jensk.synclet.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class tech.jensk.synclet.**$$serializer { *; }
# Worker werden über den Klassennamen instanziiert
-keep class tech.jensk.synclet.core.upload.UploadWorker { <init>(android.content.Context, androidx.work.WorkerParameters); }

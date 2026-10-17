package tech.jensk.synclet.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF00768A), onPrimary = Color.White,
    primaryContainer = Color(0xFFCDEEF3), onPrimaryContainer = Color(0xFF00363F),
    secondary = Color(0xFF4A6268), onSecondary = Color.White,
    secondaryContainer = Color(0xFFCDE7EC), onSecondaryContainer = Color(0xFF051F24),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFF5CC3D2), onPrimary = Color(0xFF00363F),
    primaryContainer = Color(0xFF004F5C), onPrimaryContainer = Color(0xFFCDEEF3),
    secondary = Color(0xFFB1CBD0), onSecondary = Color(0xFF1C3439),
    secondaryContainer = Color(0xFF334B50), onSecondaryContainer = Color(0xFFCDE7EC),
)

@Composable
fun SyncletTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) DarkColors else LightColors, content = content)
}

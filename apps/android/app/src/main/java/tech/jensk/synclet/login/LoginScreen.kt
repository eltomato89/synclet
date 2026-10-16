package tech.jensk.synclet.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import tech.jensk.synclet.R
import tech.jensk.synclet.core.auth.LoginError
import tech.jensk.synclet.ui.TestTags

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(
    vm: LoginViewModel,
    prefillServer: String?,
    loginHint: String?,
    onOpenBrowser: (HttpUrl) -> Unit,
    onDone: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val prefill = prefillServer?.removePrefix("https://")?.trimEnd('/').orEmpty()
    var text by rememberSaveable { mutableStateOf(prefill) }
    val submit = {
        if (!state.busy && text.isNotBlank()) scope.launch { vm.prepare(text, loginHint)?.let(onOpenBrowser) }
    }

    LaunchedEffect(state.done) { if (state.done != null) onDone() }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.login_title)) }) }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val wide = Modifier.fillMaxWidth().widthIn(max = 480.dp)
            if (loginHint != null) {
                val host = prefillServer?.substringAfter("://")?.trimEnd('/').orEmpty()
                Text(stringResource(R.string.login_again_notice, "$loginHint@$host"), wide)
            }
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text(stringResource(R.string.login_server_label)) },
                placeholder = { Text(stringResource(R.string.login_server_hint)) },
                singleLine = true,
                enabled = !state.busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onGo = { submit() }),
                modifier = wide.testTag(TestTags.LOGIN_SERVER),
            )
            Button(
                onClick = { submit() },
                enabled = !state.busy && text.isNotBlank(),
                modifier = wide.testTag(TestTags.LOGIN_CONTINUE),
            ) { Text(stringResource(R.string.login_continue)) }
            if (state.busy) LinearProgressIndicator(wide)
            state.error?.let { Text(errorText(it), wide, color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun errorText(e: Throwable): String = when (e) {
    is LoginError.InvalidAddress -> stringResource(R.string.login_error_invalid_address)
    is LoginError.InsecureAddress -> stringResource(R.string.login_error_insecure)
    is LoginError.NotSynclet -> stringResource(R.string.login_error_not_synclet, e.host)
    is LoginError.Unreachable -> stringResource(R.string.login_error_unreachable, e.host)
    is LoginError.StateMismatch -> stringResource(R.string.login_error_state)
    is LoginError.Denied -> stringResource(R.string.login_error_denied, e.reason)
    is LoginError.Expired, is LoginError.MissingCode -> stringResource(R.string.login_error_expired)
    is LoginViewModel.NoBrowserException -> stringResource(R.string.login_error_no_browser)
    else -> stringResource(R.string.login_error_generic, e.message ?: e.javaClass.simpleName)
}

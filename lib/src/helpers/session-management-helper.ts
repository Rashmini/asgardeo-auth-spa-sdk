/**
 * Copyright (c) 2020, WSO2 Inc. (http://www.wso2.org) All Rights Reserved.
 *
 * WSO2 Inc. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { SESSION_STATE } from "@asgardeo/auth-js";
import {
    CHECK_SESSION_SIGNED_IN,
    CHECK_SESSION_SIGNED_OUT,
    INITIALIZED_SILENT_SIGN_IN,
    OP_IFRAME,
    PROMPT_NONE_IFRAME,
    RP_IFRAME,
    SILENT_SIGN_IN_STATE,
    STATE
} from "../constants";
import { AuthorizationInfo, Message, SessionManagementHelperInterface } from "../models";
import { SPAUtils } from "../utils";

export const SessionManagementHelper = (() => {
    let _clientID: string;
    let _checkSessionEndpoint: string;
    let _sessionState: string;
    let _interval: number;
    let _redirectURL: string;
    let _authorizationEndpoint: string;
    let _sessionRefreshInterval: number;
    let _signOut: () => Promise<string>;
    let _sessionRefreshIntervalTimeout: number;
    let _checkSessionIntervalTimeout: number;

    const initialize = (
        clientID: string,
        checkSessionEndpoint: string,
        sessionState: string,
        interval: number,
        sessionRefreshInterval: number,
        redirectURL: string,
        authorizationEndpoint: string
    ): void => {
        _clientID = clientID;
        _checkSessionEndpoint = checkSessionEndpoint;
        _sessionState = sessionState;
        _interval = interval;
        _redirectURL = redirectURL;
        _authorizationEndpoint = authorizationEndpoint;
        _sessionRefreshInterval = sessionRefreshInterval;

        if (_interval > -1) {
            initiateCheckSession();
        }

        if (_sessionRefreshInterval > -1) {
            sessionRefreshInterval = setInterval(() => {
                sendPromptNoneRequest();
            }, _sessionRefreshInterval * 1000) as unknown as number;
        }
    };

    const initiateCheckSession = (): void => {
        if (!_checkSessionEndpoint || !_clientID || !_redirectURL) {
            return;
        }
        function startCheckSession(
            checkSessionEndpoint: string,
            clientID: string,
            redirectURL: string,
            sessionState: string,
            interval: number
        ): void {
            const OP_IFRAME = "opIFrame";

            function checkSession(): void {
                if (Boolean(clientID) && Boolean(sessionState)) {
                    const message = `${clientID} ${sessionState}`;
                    const opIframe: HTMLIFrameElement = document.getElementById(OP_IFRAME) as HTMLIFrameElement;
                    const win: Window | null = opIframe.contentWindow;
                    win?.postMessage(message, checkSessionEndpoint);
                }
            }

            const opIframe: HTMLIFrameElement = document.getElementById(OP_IFRAME) as HTMLIFrameElement;
            opIframe.src = checkSessionEndpoint + "?client_id=" + clientID + "&redirect_uri=" + redirectURL;
            checkSession();

            _checkSessionIntervalTimeout =  setInterval(checkSession, interval * 1000) as unknown as number;
        }

        const rpIFrame = document.getElementById(RP_IFRAME) as HTMLIFrameElement;
        (rpIFrame.contentWindow as any).eval(startCheckSession.toString());
        rpIFrame?.contentWindow &&
            rpIFrame?.contentWindow[startCheckSession.name](
                _checkSessionEndpoint,
                _clientID,
                _redirectURL,
                _sessionState,
                _interval
            );

        listenToResponseFromOPIFrame();
    };

    /**
     * Destroys session intervals.
     */
    const reset = (): void => {
        clearInterval(_checkSessionIntervalTimeout);
        clearInterval(_sessionRefreshIntervalTimeout);
    }

    const getRandomPKCEChallenge = (): string => {
        const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz-_";
        const stringLength = 43;
        let randomString = "";
        for (let i = 0; i < stringLength; i++) {
            const rnum = Math.floor(Math.random() * chars.length);
            randomString += chars.substring(rnum, rnum + 1);
        }
        return randomString;
    };

    const listenToResponseFromOPIFrame = (): void => {
        const rpIFrame = document.getElementById(RP_IFRAME) as HTMLIFrameElement;

        async function receiveMessage(e) {
            const targetOrigin = _checkSessionEndpoint;

            if (!targetOrigin || targetOrigin?.indexOf(e.origin) < 0) {
                return;
            }

            if (e.data === "unchanged") {
                // [RP] session state has not changed
            } else if (e.data === "error") {
                window.parent.location.href = await _signOut();
            } else {
                // [RP] session state has changed. Sending prompt=none request...
                sendPromptNoneRequest();
            }
        }

        rpIFrame?.contentWindow?.addEventListener("message", receiveMessage, false);
    };

    const sendPromptNoneRequest = () => {
        const rpIFrame = document.getElementById(RP_IFRAME) as HTMLIFrameElement;

        const promptNoneIFrame: HTMLIFrameElement = rpIFrame?.contentDocument?.getElementById(
            PROMPT_NONE_IFRAME
        ) as HTMLIFrameElement;

        if (SPAUtils.canSendPromptNoneRequest()) {
            SPAUtils.setPromptNoneRequestSent(true);

            promptNoneIFrame.src =
                _authorizationEndpoint +
                "?response_type=code" +
                "&client_id=" +
                _clientID +
                "&scope=openid" +
                "&redirect_uri=" +
                _redirectURL +
                "&state=" +
                STATE +
                "&prompt=none" +
                "&code_challenge_method=S256&code_challenge=" +
                getRandomPKCEChallenge();
        }
    };

    /**
     * This contains the logic to process the response of a prompt none request.
     *
     * @param setSessionState The method that sets the session state.
     * on the output of the content of the redirect URL
     */
    const receivePromptNoneResponse = async (
        setSessionState?: (sessionState: string | null) => Promise<void>
    ): Promise<boolean> => {
        const state = new URL(window.location.href).searchParams.get("state");
        const sessionState = new URL(window.location.href).searchParams.get(SESSION_STATE);
        const parent = window.parent.parent;

        if (state !== null && (state === STATE || state === SILENT_SIGN_IN_STATE)) {
            // Prompt none response.
            const code = new URL(window.location.href).searchParams.get("code");

            if (code !== null && code.length !== 0) {
                if (state === SILENT_SIGN_IN_STATE) {
                    const message: Message<AuthorizationInfo> = {
                        data: {
                            code,
                            sessionState: sessionState ?? ""
                        },
                        type: CHECK_SESSION_SIGNED_IN
                    };

                    sessionStorage.setItem(INITIALIZED_SILENT_SIGN_IN, "false");
                    parent.postMessage(message, parent.origin);
                    SPAUtils.setPromptNoneRequestSent(false);

                    window.location.href = "about:blank";

                    await SPAUtils.waitTillPageRedirect();

                    return true;
                }

                const newSessionState = new URL(window.location.href).searchParams.get("session_state");

                setSessionState && await setSessionState(newSessionState);
                SPAUtils.setPromptNoneRequestSent(false);

                window.location.href = "about:blank";

                await SPAUtils.waitTillPageRedirect();

                return true;
            } else {
                if (state === SILENT_SIGN_IN_STATE) {
                    const message: Message<null> = {
                        type: CHECK_SESSION_SIGNED_OUT
                    };

                    sessionStorage.setItem(INITIALIZED_SILENT_SIGN_IN, "false");
                    window.parent.parent.postMessage(message, parent.origin);
                    SPAUtils.setPromptNoneRequestSent(false);

                    window.location.href = "about:blank";

                    await SPAUtils.waitTillPageRedirect();

                    return true;
                }

                SPAUtils.setPromptNoneRequestSent(false);

                parent.location.href = await _signOut();
                window.location.href = "about:blank";

                await SPAUtils.waitTillPageRedirect();

                return true;
            }
        }

        return false;
    };

    return (signOut: () => Promise<string>): SessionManagementHelperInterface => {
        const opIFrame = document.createElement("iframe");
        opIFrame.setAttribute("id", OP_IFRAME);
        opIFrame.style.display = "none";

        let rpIFrame = document.createElement("iframe");
        rpIFrame.setAttribute("id", RP_IFRAME);
        rpIFrame.style.display = "none";

        const promptNoneIFrame = document.createElement("iframe");
        promptNoneIFrame.setAttribute("id", PROMPT_NONE_IFRAME);
        promptNoneIFrame.style.display = "none";

        document?.body?.appendChild(rpIFrame);
        rpIFrame = document.getElementById(RP_IFRAME) as HTMLIFrameElement;
        rpIFrame?.contentDocument?.body?.appendChild(opIFrame);
        rpIFrame?.contentDocument?.body?.appendChild(promptNoneIFrame);

        _signOut = signOut;

        return {
            initialize,
            receivePromptNoneResponse,
            reset
        };
    };
})();

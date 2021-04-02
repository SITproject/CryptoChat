/** The core Vue instance controlling the UI */
const vm = new Vue ({
  el: '#vue-instance',
  data () {
    return {
	  id: null,
      cryptWorker: null,
      socket: null,
      originPublicKey: null,
      destinationPublicKey: null,
      messages: [],
      notifications: [],
      currentRoom: null,
      pendingRoom: Math.floor(Math.random() * 1000),
      draft: '',
	  symKey: null,
	  IV: null,
	  hashKey: null,
	  verifySymKey: 0,
	  verifyIV: 0,
	  verifyHashKey: 0
    }
  },
  async created () {
    this.addNotification('Welcome! Generating a new keypair now.')

    // Initialize crypto webworker thread
    this.cryptWorker = new Worker('crypto-worker.js')

    // Generate keypair and join default room
    this.originPublicKey = await this.getWebWorkerResponse('generate-keys')
	this.id = await this.getWebWorkerResponse('getID')
    this.addNotification(`Keypair Generated - ${this.getKeySnippet(this.originPublicKey)}`)

    // Initialize socketio
    this.socket = io()
    this.setupSocketListeners()
  },
  methods: {
    /** Setup Socket.io event listeners */
    setupSocketListeners () {
      // Automatically join default room on connect
      this.socket.on('connect', () => {
        this.addNotification('Connected To Server.')
        this.joinRoom()
      })

      // Notify user that they have lost the socket connection
      this.socket.on('disconnect', () => this.addNotification('Lost Connection'))

      // Decrypt and display message when received
      this.socket.on('MESSAGE', async (message) => {
		if(message.code == 1){
			//decrypt keys
			const decryptedSymKey = await this.getWebWorkerResponse('PKIDecrypt', [message.key.encryptedSymKey])
			const decryptedIV = await this.getWebWorkerResponse('PKIDecrypt', [message.key.encryptedIV])
			const decryptedHashKey = await this.getWebWorkerResponse('PKIDecrypt', [message.key.encryptedHashKey])
			//decrypt signed keys
			const decryptedSignSymKey = await this.getWebWorkerResponse('PKIDecrypt', [message.signature.encryptedSignSymKey])
			const decryptedSignIV = await this.getWebWorkerResponse('PKIDecrypt', [message.signature.encryptedSignIV])
			const decryptedSignHashKey = await this.getWebWorkerResponse('PKIDecrypt', [message.signature.encryptedSignHashKey])
			//verify signature
			this.verifySymKey = await this.getWebWorkerResponse('verifySign', [decryptedSymKey, this.destinationPublicKey, decryptedSignSymKey])
			this.verifyIV = await this.getWebWorkerResponse('verifySign', [decryptedIV, this.destinationPublicKey, decryptedSignIV])
			this.verifyHashKey = await this.getWebWorkerResponse('verifySign', [decryptedHashKey, this.destinationPublicKey, decryptedSignHashKey])
			if(this.verifySymKey ==1 && this.verifyIV == 1 && this.verifyHashKey == 1){
				this.symKey = decryptedSymKey
				this.IV = decryptedIV
				this.hashKey = decryptedHashKey
			}
		}else if (this.verifySymKey ==1 && this.verifyIV == 1 && this.verifyHashKey == 1 && message.code == 2){
			//decrypt message and hash
			const decryptedMessage = await this.getWebWorkerResponse('PKIDecrypt', [message.text.encryptedEncryptedText])
			const decryptedHash = await this.getWebWorkerResponse('PKIDecrypt', [message.text.encryptedHash])
			
			//decrypt signatures
			const decryptedSignEncryptedText = await this.getWebWorkerResponse('PKIDecrypt', [message.signature.encryptedSignEncryptedText])
			const decryptedSignHash = await this.getWebWorkerResponse('PKIDecrypt', [message.signature.encryptedSignHash])	
			//verify signatures
			const verifyEncryptedText = await this.getWebWorkerResponse('verifySign', [decryptedMessage, this.destinationPublicKey, decryptedSignEncryptedText])
			const verifyHash = await this.getWebWorkerResponse('verifySign', [decryptedHash, this.destinationPublicKey, decryptedSignHash])	
			if (verifyEncryptedText == 1 && verifyHash == 1){
				//check for integrity of message (HASH)
				const producedHash = await this.getWebWorkerResponse('hmac', [this.hashKey, await this.getWebWorkerResponse('bytesToStr', [decryptedMessage])])
				if(await this.getWebWorkerResponse('bytesToStr', [producedHash]) == await this.getWebWorkerResponse('bytesToStr', [decryptedHash])){
					//Decrypt the message with symmetric key
					message.text = await this.getWebWorkerResponse('decrypt', [decryptedMessage, this.symKey, this.IV])
					this.messages.push(message)
				}else{
					this.addNotification(`Message had been deleted. Previous message seems to be modified, please establish a new session.`)
				}
			}
			else{
				this.addNotification(`Message had been deleted. Previous message seems to be modified, please establish a new session.`)
			}
		}else{
			this.addNotification(`Message had been deleted. Previous message seems to be modified, please establish a new session.`)
		}
		
     
      })

      // When a user joins the current room, send them your public key
      this.socket.on('NEW_CONNECTION', () => {
        this.addNotification('Another user joined the room.')
        this.sendPublicKey()
		//perform challenge
      })

      // Broadcast public key when a new room is joined
      this.socket.on('ROOM_JOINED', (newRoom) => {
        this.currentRoom = newRoom
        this.addNotification(`Joined Room - ${this.currentRoom}`)
        this.sendPublicKey()
      })

      // Save public key when received
      this.socket.on('PUBLIC_KEY', async(key) => {
        this.addNotification(`Public Key Received - ${key}`)
        this.destinationPublicKey = key
		//generate shared secret
		await this.getWebWorkerResponse('sharedSecret', [null, this.destinationPublicKey])
      })

      // Clear destination public key if other user leaves room
      this.socket.on('user disconnected', () => {
        this.notify(`User Disconnected - ${this.getKeySnippet(this.destinationKey)}`)
        this.destinationPublicKey = null
      })

      // Notify user that the room they are attempting to join is full
      this.socket.on('ROOM_FULL', () => {
        this.addNotification(`Cannot join ${this.pendingRoom}, room is full`)

        // Join a random room as a fallback
        this.pendingRoom = Math.floor(Math.random() * 1000)
        this.joinRoom()
      })

      // Notify room that someone attempted to join
      this.socket.on('INTRUSION_ATTEMPT', () => {
        this.addNotification('A third user attempted to join the room.')
      })
    },

    /** Encrypt and emit the current draft message */
    async sendMessage () {
      // Don't send message if there is nothing to send
      if (!this.draft || this.draft === '') { return }

      // Use immutable.js to avoid unintended side-effects.
      let message = Immutable.Map({
		code: 1,
		text: this.draft,
        recipient: this.destinationPublicKey,
        sender: this.originPublicKey,
      })	  
	  

      // Reset the UI input draft text
      this.draft = ''

      // Instantly add (unencrypted) message to local UI
      this.addMessage(message.toObject())
      if (this.destinationPublicKey) {  
		for (var i = 0 ; i < 2; i++){
			var symKey;
			var IV;
			var hashKey;
			var msg;
			if ( i == 0){
				msg = message.get('text')
				message = message.delete("text")
				/*Send keys first */
				//get 32 bytes key for encryption
				symKey = await this.getWebWorkerResponse(
				  'keyDerive', [ null ])
				//get 16 bytes IV for encryption
				IV = await this.getWebWorkerResponse(
				  'generateIV', [ null ])		
				//get 32 bytes key for hashing
				hashKey = await this.getWebWorkerResponse(
				  'keyDerive', [ null ])	
				/* Signature */
				const signSymKey = await this.getWebWorkerResponse(
				  'sign', [ symKey])
				const signIV = await this.getWebWorkerResponse(
				  'sign', [ IV])
				const signHashKey = await this.getWebWorkerResponse(
				  'sign', [ hashKey])
				/* Encrypt*/
				const encryptedSymKey = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ symKey, this.destinationPublicKey ])
				const encryptedIV = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ IV, this.destinationPublicKey ])
				const encryptedHashKey = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ hashKey, this.destinationPublicKey ])		  
				const encryptedSignSymKey = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ signSymKey, this.destinationPublicKey ])
				const encryptedSignIV = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ signIV, this.destinationPublicKey ])
				const encryptedSignHashKey = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ signHashKey, this.destinationPublicKey ])		  
				
				const encryptedMsg = message.set('key', {encryptedSymKey,encryptedIV,encryptedHashKey}).set('signature', {encryptedSignSymKey, encryptedSignIV, encryptedSignHashKey})
				console.log(encryptedMsg.toObject())
				this.socket.emit('MESSAGE', encryptedMsg.toObject())
			}else{
				//Hybrid cryptography 
				
				//Encrypted text with AES OFB E(M) || H(E(M))
				const encryptedText = await this.getWebWorkerResponse(
				  'encrypt', [ msg, symKey, IV ])
				
				  //HASH OF ENCRYPTED TEXT EtM
				const hash = await this.getWebWorkerResponse('hmac', [hashKey, encryptedText])
				
				//Sign
				const signEncryptedText = await this.getWebWorkerResponse(
				  'sign', [ await this.getWebWorkerResponse('strToBytes', [encryptedText]) ])
				const signHash = await this.getWebWorkerResponse(
				  'sign', [ hash ])

				//Encrypt
				const encryptedEncryptedText = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ await this.getWebWorkerResponse('strToBytes', [encryptedText]), this.destinationPublicKey ])
				const encryptedHash = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ hash, this.destinationPublicKey ])
				const encryptedSignEncryptedText = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ signEncryptedText, this.destinationPublicKey ])				  
				const encryptedSignHash = await this.getWebWorkerResponse(
				  'PKIEncrypt', [ signHash, this.destinationPublicKey ])					  
				  
				const newMsg = message.set('text', {encryptedEncryptedText, encryptedHash}).set('signature', {encryptedSignEncryptedText, encryptedSignHash}).set('code', 2)
				console.log(newMsg.toObject()) 
				setTimeout(() => { this.socket.emit('MESSAGE', newMsg.toObject()) }, 500);
				
			}
		}
      }
    },

    /** Join the specified chatroom */
    joinRoom () {
      if (this.pendingRoom !== this.currentRoom && this.originPublicKey) {
        this.addNotification(`Connecting to Room - ${this.pendingRoom}`)

        // Reset room state variables
        this.messages = []
        this.destinationPublicKey = null
        // Emit room join request.
        this.socket.emit('JOIN', this.pendingRoom)
      }
    },

    /** Add message to UI, and scroll the view to display the new message. */
    addMessage (message) {
      this.messages.push(message)
      this.autoscroll(this.$refs.chatContainer)
    },

    /** Append a notification message in the UI */
    addNotification (message) {
      const timestamp = new Date().toLocaleTimeString()
      this.notifications.push({ message, timestamp })
      this.autoscroll(this.$refs.notificationContainer)
    },

    /** Post a message to the webworker, and return a promise that will resolve with the response.  */
    getWebWorkerResponse (messageType, messagePayload) {
      return new Promise((resolve, reject) => {
        // Generate a random message id to identify the corresponding event callback
        const messageId = Math.floor(Math.random() * 100000)

        // Post the message to the webworker
        this.cryptWorker.postMessage([messageType, messageId].concat(messagePayload))

        // Create a handler for the webworker message event
        const handler = function (e) {
          // Only handle messages with the matching message id
          if (e.data[0] === messageId) {
            // Remove the event listener once the listener has been called.
            e.currentTarget.removeEventListener(e.type, handler)

            // Resolve the promise with the message payload.
            resolve(e.data[1])
          }
        }

        // Assign the handler to the webworker 'message' event.
        this.cryptWorker.addEventListener('message', handler)
      })
    },

    /** Emit the public key to all users in the chatroom */
    sendPublicKey () {
      if (this.originPublicKey) {
        this.socket.emit('PUBLIC_KEY', this.originPublicKey)
      }
    },
	
    /** Get key snippet for display purposes */
    getKeySnippet (key) {
      return key.slice(10, 16)
    },

    /** Autoscoll DOM element to bottom */
    autoscroll (element) {
      if (element) { element.scrollTop = element.scrollHeight }
    }
  }
})

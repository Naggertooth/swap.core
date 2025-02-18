import debug from 'debug'
import crypto from 'bitcoinjs-lib/src/crypto' // move to BtcSwap
import SwapApp, { constants, util } from 'swap.app'
import { Flow } from 'swap.swap'


class ETH2BTC extends Flow {

  static getName() {
    return `${this.getFromName()}2${this.getToName()}`
  }
  static getFromName() {
    return constants.COINS.eth
  }
  static getToName() {
    return constants.COINS.btc
  }
  constructor(swap) {
    super(swap)

    this._flowName = ETH2BTC.getName()

    this.stepNumbers = {
      'sign': 1,
      'wait-lock-btc': 2,
      'verify-script': 3,
      'sync-balance': 4,
      'lock-eth': 5,
      'wait-withdraw-eth': 6, // aka getSecret
      'withdraw-btc': 7,
      'finish': 8,
      'end': 9
    }

    this.ethSwap = swap.participantSwap
    this.btcSwap = swap.ownerSwap

    if (!this.ethSwap) {
      throw new Error('BTC2ETH: "ethSwap" of type object required')
    }
    if (!this.btcSwap) {
      throw new Error('BTC2ETH: "btcSwap" of type object required')
    }

    this.state = {
      step: 0,

      isStoppedSwap: false,

      signTransactionHash: null,
      isSignFetching: false,
      isMeSigned: false,

      targetWallet : null,
      secretHash: null,
      btcScriptValues: null,

      btcScriptVerified: false,

      isBalanceFetching: false,
      isBalanceEnough: true,
      balance: null,

      btcScriptCreatingTransactionHash: null,
      ethSwapCreationTransactionHash: null,
      canCreateEthTransaction: true,
      isEthContractFunded: false,

      secret: null,

      isEthWithdrawn: false,
      isBtcWithdrawn: false,

      ethSwapWithdrawTransactionHash: null,
      btcSwapWithdrawTransactionHash: null,

      refundTransactionHash: null,
      isRefunded: false,

      isFinished: false,
      isSwapExist: false,

      withdrawRequestIncoming: false,
      withdrawRequestAccepted: false,
      isSignFetching: false,
      isMeSigned: false,
    }

    super._persistSteps()
    this._persistState()

    const flow = this
    flow.swap.room.once('request withdraw', () => {
      flow.setState({
        withdrawRequestIncoming: true,
      })
    })
  }

  _persistState() {
    super._persistState()
  }

  _getSteps() {
    const flow = this

    return [

      // 1. Sign swap to start

      () => {
        // this.sign()
      },

      // 2. Wait participant create, fund BTC Script

      () => {
        flow.swap.room.on('create btc script', ({ scriptValues, btcScriptCreatingTransactionHash }) => {
          const { step } = flow.state

          if (step >= 3) {
            return
          }

          flow.finishStep({
            secretHash: scriptValues.secretHash,
            btcScriptValues: scriptValues,
            btcScriptCreatingTransactionHash,
          }, { step: 'wait-lock-btc', silentError: true })
        })

        flow.swap.room.sendMessage({
          event: 'request btc script',
        })
      },

      // 3. Verify BTC Script

      () => {
        debug('swap.core:flow')(`waiting verify btc script`)
        // this.verifyBtcScript()
      },

      // 4. Check balance

      () => {
        this.syncBalance()
      },

      // 5. Create ETH Contract

      async () => {
        const { participant, buyAmount, sellAmount } = flow.swap
        const { secretHash } = flow.state

        const utcNow = () => Math.floor(Date.now() / 1000)

        const isBtcScriptOk = await util.helpers.repeatAsyncUntilResult(async (stopRepeat) => {
          const { btcScriptValues } = flow.state

          const scriptCheckError = await flow.btcSwap.checkScript(btcScriptValues, {
            value: buyAmount,
            recipientPublicKey: this.app.services.auth.accounts.btc.getPublicKey(),
            lockTime: utcNow(),
            confidence: 0.8,
          })

          if (scriptCheckError) {
            if (/Expected script lockTime/.test(scriptCheckError)) {
              console.error('Btc script check error: btc was refunded', scriptCheckError)
              flow.stopSwapProcess()
              stopRepeat()
            } else if (/Expected script value/.test(scriptCheckError)) {
              console.warn('Btc script check: waiting balance')
            } else {
              flow.swap.events.dispatch('btc script check error', scriptCheckError)
            }

            return false
          } else {
            return true
          }
        })

        if (!isBtcScriptOk) {
          return
        }

        const swapData = {
          participantAddress: participant.eth.address,
          secretHash: secretHash,
          amount: sellAmount,
          targetWallet: flow.swap.destinationSellAddress
        }

        const tryCreateSwap = async () => {
          const { isEthContractFunded } = flow.state

          if (!isEthContractFunded) {
            try {
              debug('swap.core:flow')('create swap', swapData)
              await this.ethSwap.create(swapData, (hash) => {
                debug('swap.core:flow')('create swap tx hash', hash)
                flow.swap.room.sendMessage({
                  event: 'create eth contract',
                  data: {
                    ethSwapCreationTransactionHash: hash,
                  },
                })

                flow.swap.room.on('request eth contract', () => {
                  flow.swap.room.sendMessage({
                    event: 'create eth contract',
                    data: {
                      ethSwapCreationTransactionHash: hash,
                    },
                  })
                })

                flow.setState({
                  ethSwapCreationTransactionHash: hash,
                  canCreateEthTransaction: true,
                })
              })
            } catch (err) {
              if ( /known transaction/.test(err.message) ) {
                console.error(`known tx: ${err.message}`)
              } else if ( /out of gas/.test(err.message) ) {
                console.error(`tx failed (wrong secret?): ${err.message}`)
              } else {
                console.error(err)
              }

              flow.setState({
                canCreateEthTransaction: false,
              })

              return null
            }
          }
          return true
        }

        const isEthContractFunded = await util.helpers.repeatAsyncUntilResult(() =>
          tryCreateSwap(),
        )

        const { isStoppedSwap } = flow.state

        if (isEthContractFunded && !isStoppedSwap) {
          debug('swap.core:flow')(`finish step`)
          flow.finishStep({
            isEthContractFunded,
          }, {step: 'lock-eth'})
        }
      },

      // 6. Wait participant withdraw

      async () => {
        flow.swap.room.once('ethWithdrawTxHash', async ({ethSwapWithdrawTransactionHash}) => {
          flow.setState({
            ethSwapWithdrawTransactionHash,
          }, true)

          let secretFromTxhash = await util.helpers.repeatAsyncUntilResult(() => {
            const { secret } = flow.state

            if (secret) {
              return secret
            } else {
              return flow.ethSwap.getSecretFromTxhash(ethSwapWithdrawTransactionHash)
            }
          })

          secretFromTxhash = `0x${secretFromTxhash.replace(/^0x/, '')}`

          const { isEthWithdrawn } = flow.state

          if (!isEthWithdrawn && secretFromTxhash) {
            debug('swap.core:flow')('got secret from tx', ethSwapWithdrawTransactionHash, secretFromTxhash)
            flow.finishStep({
              isEthWithdrawn: true,
              secret: secretFromTxhash,
            }, {step: 'wait-withdraw-eth'})
          }
        })

        flow.swap.room.sendMessage({
          event: 'request ethWithdrawTxHash',
        })

        // If partner decides to scam and doesn't send ethWithdrawTxHash
        // then we try to withdraw as in ETHTOKEN2USDT

        const { participant } = flow.swap

        const checkSecretExist = async () => {
          try {
            let secretFromContract = await flow.ethSwap.getSecret({
              participantAddress: participant.eth.address,
            })

            if (secretFromContract) {

              secretFromContract = `0x${secretFromContract.replace(/^0x/, '')}`

              return secretFromContract
            } else {
              return null
            }
          }
          catch (err) {
            return null
          }
        }

        const secretFromContract = await util.helpers.repeatAsyncUntilResult((stopRepeat) => {
          const { isEthWithdrawn, isRefunded } = flow.state

          if (isEthWithdrawn || isRefunded) {
            stopRepeat()

            return false
          }

          return checkSecretExist()
        })

        const { isEthWithdrawn } = this.state

        if (secretFromContract && !isEthWithdrawn) {
          debug('swap.core:flow')('got secret from smart contract', secretFromContract)

          flow.finishStep({
            isEthWithdrawn: true,
            secret: secretFromContract,
          }, { step: 'wait-withdraw-eth' })
        }
      },

      // 7. Withdraw

      async () => {
        await util.helpers.repeatAsyncUntilResult((stopRepeat) => {
          const { secret, btcScriptValues, destinationBuyAddress, btcSwapWithdrawTransactionHash } = flow.state

          if (btcSwapWithdrawTransactionHash) {
            return true
          }

          if (!btcScriptValues) {
            console.error('There is no "btcScriptValues" in state. No way to continue swap...')
            return null
          }

          return flow.btcSwap.withdraw({
            scriptValues: btcScriptValues,
            secret,
            destinationAddress: destinationBuyAddress,
          })
            .then((hash) => {
              flow.setState({
                btcSwapWithdrawTransactionHash: hash,
              }, true)
              return true
            })
            .catch((error) => null)
        })

        flow.finishStep({
          isBtcWithdrawn: true,
        }, { step: 'withdraw-btc' })
      },

      // 8. Finish

      () => {
        flow.swap.room.once('request swap finished', () => {
          const { btcSwapWithdrawTransactionHash } = flow.state

          flow.swap.room.sendMessage({
            event: 'swap finished',
            data: {
              btcSwapWithdrawTransactionHash,
            },
          })
        })

        flow.finishStep({
          isFinished: true,
        }, { step: 'finish' })
      },

      // 9. Finished!

      () => {}
    ]
  }

  acceptWithdrawRequest() {
    const flow = this
    const { withdrawRequestAccepted } = flow.state

    if (withdrawRequestAccepted) {
      return
    }

    this.setState({
      withdrawRequestAccepted: true,
    })

    this.swap.room.once('do withdraw', async ({secret}) => {
      try {
        const data = {
          participantAddress: flow.swap.participant.eth.address,
          secret,
        }

        await flow.ethSwap.withdrawNoMoney(data, (hash) => {
          flow.swap.room.sendMessage({
            event: 'withdraw ready',
            data: {
              ethSwapWithdrawTransactionHash: hash,
            }
          })
        })
      } catch (err) {
        debug('swap.core:flow')(err.message)
      }
    })

    this.swap.room.sendMessage({
      event: 'accept withdraw request'
    })
  }

  _checkSwapAlreadyExists() {
    const { participant } = this.swap

    const swapData = {
      ownerAddress: this.app.services.auth.accounts.eth.address,
      participantAddress: participant.eth.address
    }

    return this.ethSwap.checkSwapExists(swapData)
  }

  async sign() {
    const flow = this
    const swapExists = await flow._checkSwapAlreadyExists()

    if (swapExists) {
      flow.swap.room.sendMessage({
        event: 'swap exists',
      })

      flow.setState({
        isSwapExist: true,
      })

      flow.stopSwapProcess()
    } else {
      const { isSignFetching, isMeSigned } = flow.state

      if (isSignFetching || isMeSigned) {
        return true
      }

      flow.setState({
        isSignFetching: true,
      })

      flow.swap.room.once('btc refund completed', () => {
        flow.tryRefund()
      })

      flow.swap.room.on('request sign', () => {
        flow.swap.room.sendMessage({
          event: 'swap sign',
        })
      })

      flow.swap.room.sendMessage({
        event: 'swap sign',
      })

      flow.finishStep({
        isMeSigned: true,
      }, { step: 'sign', silentError: true })

      return true
    }
  }

  verifyBtcScript() {
    const flow = this
    const { btcScriptVerified, btcScriptValues } = flow.state

    if (btcScriptVerified) {
      return true
    }

    if (!btcScriptValues) {
      throw new Error(`No script, cannot verify`)
    }

    flow.finishStep({
      btcScriptVerified: true,
    }, { step: 'verify-script' })

    return true
  }

  async syncBalance() {
    const { sellAmount } = this.swap

    this.setState({
      isBalanceFetching: true,
    })

    const balance = await this.ethSwap.fetchBalance(this.app.services.auth.accounts.eth.address)
    const isEnoughMoney = sellAmount.isLessThanOrEqualTo(balance)

    const stateData = {
      balance,
      isBalanceFetching: false,
      isBalanceEnough: isEnoughMoney,
    }

    if (isEnoughMoney) {
      this.finishStep(stateData, { step: 'sync-balance' })
    }
    else {
      this.setState(stateData, true)
    }
  }

  async tryRefund() {
    const { participant } = this.swap
    const { secretHash, isEthContractFunded, isRefunded } = this.state

    if (!isEthContractFunded || isRefunded) {
      return false
    }

    const refundHandler = (hash = null) => {
      this.swap.room.sendMessage({
        event: 'eth refund completed',
      })

      this.setState({
        refundTransactionHash: hash,
        isRefunded: true,
        isSwapExist: false,
      }, true)
    }

    try {
      const wasRefunded = await this.ethSwap.wasRefunded({ secretHash })

      if (wasRefunded) {
        debug('swap.core:flow')('This swap was refunded')

        refundHandler()

        return true
      }
    } catch (error) {
      console.warn('wasRefunded error:', error)

      return false
    }

    return this.ethSwap.refund({
      participantAddress: participant.eth.address,
    })
      .then((hash) => {
        if (!hash) {
          return false
        }

        refundHandler(hash)

        return true
      })
      .catch((error) => false)
  }

  stopSwapProcess() {
    const flow = this

    console.warn('Swap was stopped')

    flow.setState({
      isStoppedSwap: true,
    }, true)
  }

  async tryWithdraw(_secret) {
    const { secret, secretHash, isEthWithdrawn, isBtcWithdrawn, btcScriptValues } = this.state

    if (!_secret)
      throw new Error(`Withdrawal is automatic. For manual withdrawal, provide a secret`)

    if (!btcScriptValues)
      throw new Error(`Cannot withdraw without script values`)

    if (secret && secret != _secret)
      console.warn(`Secret already known and is different. Are you sure?`)

    if (isBtcWithdrawn)
      console.warn(`Looks like money were already withdrawn, are you sure?`)

    debug('swap.core:flow')(`WITHDRAW using secret = ${_secret}`)

    const _secretHash = crypto.ripemd160(Buffer.from(_secret, 'hex')).toString('hex')

    if (secretHash != _secretHash)
      console.warn(`Hash does not match! state: ${secretHash}, given: ${_secretHash}`)

    const { scriptAddress } = this.btcSwap.createScript(btcScriptValues)
    const balance = await this.btcSwap.getBalance(scriptAddress)

    debug('swap.core:flow')(`address=${scriptAddress}, balance=${balance}`)

    if (balance === 0) {
      this.finishStep({
        isBtcWithdrawn: true,
      }, { step: 'withdraw-btc' })
      throw new Error(`Already withdrawn: address=${scriptAddress},balance=${balance}`)
    }

    await this.btcSwap.withdraw({
      scriptValues: btcScriptValues,
      secret: _secret,
    }, (hash) => {
      debug('swap.core:flow')(`TX hash=${hash}`)
      this.setState({
        btcSwapWithdrawTransactionHash: hash,
      })
    })
    debug('swap.core:flow')(`TX withdraw sent: ${this.state.btcSwapWithdrawTransactionHash}`)

    this.finishStep({
      isBtcWithdrawn: true,
    }, { step: 'withdraw-btc' })
  }

}


export default ETH2BTC
